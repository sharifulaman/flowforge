import { Inject, Injectable } from '@nestjs/common';
import { API_ENV, type ApiEnv } from '../../config/env';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/**
 * Abstract so tests (and future providers) can substitute an implementation.
 * The real implementation talks to Google's OAuth 2.0 / OIDC endpoints with PKCE.
 */
export abstract class GoogleOAuthClient {
  abstract isConfigured(): boolean;
  abstract buildAuthUrl(params: { state: string; codeChallenge: string }): string;
  abstract exchangeCode(params: { code: string; codeVerifier: string }): Promise<GoogleProfile>;
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export class GoogleOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

@Injectable()
export class HttpGoogleOAuthClient extends GoogleOAuthClient {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    super();
  }

  private get redirectUri(): string {
    return this.env.GOOGLE_REDIRECT_URI ?? `${this.env.WEB_URL}/api/v1/auth/google/callback`;
  }

  isConfigured(): boolean {
    return Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET);
  }

  buildAuthUrl({ state, codeChallenge }: { state: string; codeChallenge: string }): string {
    const url = new URL(AUTH_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier: string }): Promise<GoogleProfile> {
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: this.env.GOOGLE_CLIENT_ID,
        client_secret: this.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new GoogleOAuthError(`Token exchange failed (${tokenRes.status})`);
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) throw new GoogleOAuthError('Token response missing access_token');

    const infoRes = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!infoRes.ok) throw new GoogleOAuthError(`Userinfo request failed (${infoRes.status})`);
    const info = (await infoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!info.sub || !info.email) throw new GoogleOAuthError('Userinfo missing sub/email');
    return {
      sub: info.sub,
      email: info.email.toLowerCase(),
      emailVerified: info.email_verified === true,
      name: info.name,
      picture: info.picture,
    };
  }
}
