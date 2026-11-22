import { Body, Controller, Get, Header, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { AppManifest, ConnectorRegistry, SelectOption } from '@flowforge/connector-sdk';
import type { CredentialStore, SafeHttpClient } from '@flowforge/engine';
import { toConnectorLogger } from '@flowforge/engine';
import { type LoadOptionsInput, loadOptionsSchema } from '@flowforge/shared';
import type { FastifyRequest } from 'fastify';
import { Req } from '@nestjs/common';
import { ApiException } from '../../common/api-exception';
import { AllowApiKey, CurrentWorkspace } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CONNECTOR_REGISTRY, CREDENTIAL_STORE, SAFE_HTTP } from '../../runtime/tokens';
import type { WorkspaceContext } from '../../types/principal';
import { API_CONNECTOR_TIMEOUT_MS, connectorErrorToHttp } from './connector-context';

@Controller()
export class AppsController {
  constructor(
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(CREDENTIAL_STORE) private readonly credentials: CredentialStore,
    @Inject(SAFE_HTTP) private readonly http: SafeHttpClient,
  ) {}

  /** Catalogue of apps with JSON-schema inputs — the builder renders forms from this. */
  @Get('apps')
  @AllowApiKey()
  @Header('cache-control', 'private, max-age=60')
  list(): AppManifest[] {
    return this.registry.manifests();
  }

  @Get('apps/:appKey')
  @AllowApiKey()
  get(@Param('appKey') appKey: string): AppManifest {
    const app = this.registry.get(appKey);
    if (!app) throw ApiException.notFound('App');
    return this.registry.manifest(app);
  }

  /** Dynamic dropdown options (e.g. Slack channels) for a step field. */
  @Post('workspaces/:workspaceId/apps/:appKey/options')
  @AllowApiKey()
  @UseGuards(WorkspaceGuard)
  async options(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('appKey') appKey: string,
    @Body(new ZodPipe(loadOptionsSchema)) body: LoadOptionsInput,
    @Req() req: FastifyRequest,
  ): Promise<SelectOption[]> {
    const app = this.registry.get(appKey);
    const loader = app?.optionLoaders?.[body.loader];
    if (!app || !loader) throw ApiException.notFound('Options loader');

    let auth: Record<string, unknown> = {};
    if (app.auth.type !== 'none') {
      if (!body.connectionId) throw ApiException.badRequest(`Choose a ${app.name} account first`);
      const conn = await this.credentials
        .getAuth(ws.id, body.connectionId)
        .catch((err) => {
          throw err?.name === 'ConnectionNotFoundError' ? ApiException.notFound('Connection') : connectorErrorToHttp(err, 'Could not load credentials');
        });
      auth = conn;
    }

    const signal = AbortSignal.timeout(API_CONNECTOR_TIMEOUT_MS);
    try {
      const options = await loader({
        auth,
        config: body.config,
        http: this.http.withSignal(signal),
        logger: toConnectorLogger(req.log),
        signal,
        workspaceId: ws.id,
      });
      return options.slice(0, 1000);
    } catch (err) {
      throw connectorErrorToHttp(err, `Could not load options from ${app.name}`);
    }
  }
}
