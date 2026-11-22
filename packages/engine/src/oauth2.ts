import { AuthError, RetryableError, FatalError, type AuthDefinition, type OAuth2Credentials } from '@flowforge/connector-sdk';
import { createHash } from 'node:crypto';

export type OAuth2Auth = Extract<AuthDefinition, { type: 'oauth2' }>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export function oauthClientCredentials(auth: OAuth2Auth, env: Record<string, string | undefined>): OAuthClientCredentials | null {
  const clientId = env[auth.clientIdEnv];
  const clientSecret = env[auth.clientSecretEnv];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizeUrl(
  auth: OAuth2Auth,
  p: { clientId: string; redirectUri: string; state: string; codeVerifier?: string },
): string {
  const url = new URL(auth.authorizeUrl);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    state: p.state,
    scope: auth.scopes.join(auth.scopeSeparator ?? ' '),
    ...auth.authorizeParams,
  };
  if (auth.pkce !== false && p.codeVerifier) {
    params.code_challenge = pkceChallenge(p.codeVerifier);
    params.code_challenge_method = 'S256';
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  auth: OAuth2Auth,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(auth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new RetryableError(`OAuth token endpoint unreachable: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: TokenResponse;
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    data = Object.fromEntries(new URLSearchParams(text)) as TokenResponse;
  }
  if (!res.ok || data.error) {
    const reason = data.error_description ?? data.error ?? `HTTP ${res.status}`;
    if (data.error === 'invalid_grant' || res.status === 401) throw new AuthError(`OAuth authorization is no longer valid: ${reason}`);
    if (res.status >= 500 || res.status === 429) throw new RetryableError(`OAuth token endpoint error: ${reason}`);
    throw new FatalError(`OAuth token request failed: ${reason}`, 'OAUTH_ERROR');
  }
  if (!data.access_token) throw new FatalError('OAuth token response has no access_token', 'OAUTH_ERROR');
  return data;
}

function toCredentials(data: TokenResponse, previous?: OAuth2Credentials): OAuth2Credentials {
  const expiresIn = data.expires_in !== undefined ? Number(data.expires_in) : undefined;
  return {
    accessToken: data.access_token!,
    // Many providers omit the refresh token on refresh: keep the old one.
    refreshToken: data.refresh_token ?? previous?.refreshToken,
    expiresAt: expiresIn && Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    tokenType: data.token_type ?? 'Bearer',
    scope: data.scope ?? previous?.scope,
  };
}

export async function exchangeCode(
  auth: OAuth2Auth,
  p: { code: string; redirectUri: string; codeVerifier?: string } & OAuthClientCredentials,
  fetchImpl: FetchLike = fetch,
): Promise<OAuth2Credentials> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    client_secret: p.clientSecret,
  };
  if (auth.pkce !== false && p.codeVerifier) body.code_verifier = p.codeVerifier;
  return toCredentials(await tokenRequest(auth, body, fetchImpl));
}

export async function refreshAccessToken(
  auth: OAuth2Auth,
  creds: OAuth2Credentials,
  client: OAuthClientCredentials,
  fetchImpl: FetchLike = fetch,
): Promise<OAuth2Credentials> {
  if (!creds.refreshToken) throw new AuthError('Access token expired and no refresh token is available — reconnect');
  const data = await tokenRequest(
    auth,
    {
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    fetchImpl,
  );
  return toCredentials(data, creds);
}

/** Refresh slightly before expiry to avoid using a token that dies mid-request. */
export const REFRESH_SKEW_MS = 2 * 60_000;

export function needsRefresh(creds: OAuth2Credentials, now = Date.now()): boolean {
  return !!creds.expiresAt && Date.parse(creds.expiresAt) - now <= REFRESH_SKEW_MS;
}
