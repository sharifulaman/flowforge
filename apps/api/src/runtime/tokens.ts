export const CONNECTOR_REGISTRY = Symbol('CONNECTOR_REGISTRY');
export const CREDENTIAL_STORE = Symbol('CREDENTIAL_STORE');
export const SAFE_HTTP = Symbol('SAFE_HTTP');
export const RUNS_QUEUE = Symbol('RUNS_QUEUE');
export const TRIGGERS_QUEUE = Symbol('TRIGGERS_QUEUE');
export const RUN_LAUNCHER = Symbol('RUN_LAUNCHER');
export const TRIGGER_MANAGER = Symbol('TRIGGER_MANAGER');
/** fetch used for OAuth token exchanges (overridable in tests). */
export const OAUTH_FETCH = Symbol('OAUTH_FETCH');
