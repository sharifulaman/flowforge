import type { ApiErrorBody, ErrorCode } from '@flowforge/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    public readonly issues: Array<{ path: string; message: string }> = [],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field → message map, handy for react-hook-form `setError`. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.issues.map((i) => [i.path, i.message]));
  }
}

const API_BASE = '/api/v1';
const NO_REFRESH_PATHS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

const AUTH_PAGES = ['/login', '/register'];

let refreshInFlight: Promise<boolean> | null = null;

/** Single-flight refresh: concurrent 401s share one /auth/refresh call. */
function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return new ApiError(res.status, body.error.code, body.error.message, body.error.issues, body.error.requestId);
  } catch {
    return new ApiError(res.status, 'INTERNAL', res.statusText || 'Request failed');
  }
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, allow404, headers, ...init } = opts;
  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res: Response;
  try {
    res = await doFetch();
    if (res.status === 401 && !NO_REFRESH_PATHS.includes(path)) {
      if (await refreshSession()) {
        res = await doFetch();
      } else if (typeof window !== 'undefined' && !AUTH_PAGES.includes(window.location.pathname)) {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.assign(`/login?returnTo=${returnTo}`);
      }
    }
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error — check your connection and try again.');
  }

  if (res.status === 404 && allow404) return null as T;
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
