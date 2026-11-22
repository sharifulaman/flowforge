/** Cookie names shared by the API (sets them) and the web middleware (reads presence). */
export const AUTH_COOKIES = {
  access: 'ff_at',
  refresh: 'ff_rt',
  oauthState: 'ff_oauth',
  /** Non-secret marker ("has a session") readable by the web middleware on every path. */
  session: 'ff_s',
} as const;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Path the refresh cookie is scoped to, so it is only sent to auth endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const API_KEY_PREFIX = 'ff_live_';
