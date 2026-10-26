import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { BootstrapAdminService } from './bootstrap-admin.service';

@Module({
  providers: [UsersService, BootstrapAdminService],
  exports: [UsersService],
})
export class UsersModule {}
