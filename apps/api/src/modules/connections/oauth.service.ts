import { Inject, Injectable } from '@nestjs/common';
import { buildAuthorizeUrl, exchangeCode, type FetchLike, oauthClientCredentials, type OAuth2Auth } from '@flowforge/engine';
import { randomToken } from '@flowforge/shared/node';
import type { Redis } from 'ioredis';
import { ApiException } from '../../common/api-exception';
import { API_ENV, type ApiEnv } from '../../config/env';
import { REDIS } from '../../redis/redis.constants';
import { OAUTH_FETCH } from '../../runtime/tokens';
import { ConnectionsService } from './connections.service';

interface OAuthState {
  workspaceId: string;
  userId: string;
  appKey: string;
  codeVerifier: string;
  name?: string;
  connectionId?: string;
}

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `ff:oauth:conn:${state}`;

/**
 * Generic OAuth2 authorization-code flow (with PKCE) for any connector whose auth is `oauth2`.
 * State lives in Redis, single-use, bound to the user and workspace that started the flow.
 */
@Injectable()
export class OAuthService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OAUTH_FETCH) private readonly fetchImpl: FetchLike,
    private readonly connections: ConnectionsService,
  ) {}

  get redirectUri(): string {
    return `${this.env.WEB_URL}/api/v1/connections/oauth/callback`;
  }

  async start(p: Omit<OAuthState, 'codeVerifier'>): Promise<string> {
    const app = this.connections.appOrThrow(p.appKey);
    if (app.auth.type !== 'oauth2') throw ApiException.badRequest(`${app.name} does not use OAuth`);
    const client = oauthClientCredentials(app.auth, process.env);
    if (!client) throw ApiException.badRequest(`${app.name} sign-in is not configured on this server`);

    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    await this.redis.set(stateKey(state), JSON.stringify({ ...p, codeVerifier } satisfies OAuthState), 'EX', STATE_TTL_SECONDS);
    return buildAuthorizeUrl(app.auth, { clientId: client.clientId, redirectUri: this.redirectUri, state, codeVerifier });
  }

  /** Returns the web URL to redirect the browser to (success or error). */
  async callback(p: { userId: string | null; state?: string; code?: string; error?: string }): Promise<string> {
    const fail = (workspaceId: string | null, reason: string) =>
      workspaceId
        ? `${this.env.WEB_URL}/w/${workspaceId}/connections?error=${encodeURIComponent(reason)}`
        : `${this.env.WEB_URL}/?oauth_error=${encodeURIComponent(reason)}`;

    if (!p.state) return fail(null, 'Missing OAuth state');
    const raw = await this.redis.getdel(stateKey(p.state));
    if (!raw) return fail(null, 'Sign-in session expired — please try again');
    const st = JSON.parse(raw) as OAuthState;

    if (!p.userId || p.userId !== st.userId) return fail(st.workspaceId, 'Sign-in was started by a different user');
    if (p.error) return fail(st.workspaceId, p.error === 'access_denied' ? 'Access was denied' : `Provider error: ${p.error}`);
    if (!p.code) return fail(st.workspaceId, 'Missing authorization code');

    const app = this.connections.appOrThrow(st.appKey);
    const auth = app.auth as OAuth2Auth;
    const client = oauthClientCredentials(auth, process.env);
    if (!client) return fail(st.workspaceId, `${app.name} sign-in is not configured`);

    try {
      const tokens = await exchangeCode(
        auth,
        { code: p.code, redirectUri: this.redirectUri, codeVerifier: st.codeVerifier, ...client },
        this.fetchImpl,
      );
      const conn = await this.connections.saveOAuth(
        { workspaceId: st.workspaceId, userId: st.userId, app, name: st.name, connectionId: st.connectionId },
        tokens,
      );
      return `${this.env.WEB_URL}/w/${st.workspaceId}/connections?connected=${conn.id}`;
    } catch (err) {
      return fail(st.workspaceId, `Could not connect ${app.name}: ${(err as Error).message}`.slice(0, 300));
    }
  }
}
