import { Global, Module } from '@nestjs/common';
import { ApiKeyAuthService } from './api-key-auth.service';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

@Global()
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeyAuthService, ApiKeysService],
  exports: [ApiKeyAuthService],
})
export class ApiKeysModule {}
