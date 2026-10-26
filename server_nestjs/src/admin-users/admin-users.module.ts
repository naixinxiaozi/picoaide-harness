import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { UsersModule } from '../users/users.module';

import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [UsersModule, AuditModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminUsersModule {}
