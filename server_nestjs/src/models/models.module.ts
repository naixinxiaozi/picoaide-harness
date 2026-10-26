import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ModelsService } from './models.service';
import { ModelsController } from './models.controller';

@Module({
  imports: [AuditModule],
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
