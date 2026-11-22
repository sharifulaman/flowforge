import type { Principal, WorkspaceContext } from './principal';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Principal;
    workspace?: WorkspaceContext;
  }
}
