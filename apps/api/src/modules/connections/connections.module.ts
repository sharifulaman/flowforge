import { Module } from '@nestjs/common';
import { ConnectionsController, OAuthCallbackController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { OAuthService } from './oauth.service';

@Module({
  controllers: [ConnectionsController, OAuthCallbackController],
  providers: [ConnectionsService, OAuthService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
