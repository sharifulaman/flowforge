import { Module } from '@nestjs/common';
import { ZapLifecycleService } from './lifecycle.service';
import { StepTestService } from './step-test.service';
import { StepsService } from './steps.service';
import { ZapsController } from './zaps.controller';
import { ZapsService } from './zaps.service';

@Module({
  controllers: [ZapsController],
  providers: [ZapsService, StepsService, ZapLifecycleService, StepTestService],
  exports: [ZapsService],
})
export class ZapsModule {}
