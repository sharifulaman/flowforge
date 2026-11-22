import { Global, Module } from '@nestjs/common';
import { ApiKeyAuthService } from './api-key-auth.service';

/** Phase (a): authentication only. Create/list/revoke endpoints arrive in phase (b). */
@Global()
@Module({
  providers: [ApiKeyAuthService],
  exports: [ApiKeyAuthService],
})
export class ApiKeysModule {}
