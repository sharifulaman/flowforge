import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleOAuthClient, HttpGoogleOAuthClient } from './google-oauth.client';
import { PasswordService } from './password.service';
import { TokensService } from './tokens.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokensService,
    { provide: GoogleOAuthClient, useClass: HttpGoogleOAuthClient },
  ],
  exports: [TokensService],
})
export class AuthModule {}
