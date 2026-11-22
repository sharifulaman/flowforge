import { type DynamicModule, Global, Module } from '@nestjs/common';
import { SecretBox } from '@flowforge/shared/node';
import { API_ENV, type ApiEnv } from './env';

export const SECRET_BOX = Symbol('SECRET_BOX');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: SECRET_BOX, useValue: SecretBox.fromConfig(env) },
      ],
      exports: [API_ENV, SECRET_BOX],
    };
  }
}
