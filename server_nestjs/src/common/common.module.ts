import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto/crypto.service';
import { BearerAuthGuard } from './guards/bearer-auth.guard';
import { AdminAuthGuard } from './guards/admin-auth.guard';
import { RbacGuard } from './guards/rbac.guard';

/** 公共层：crypto + 全部守卫（各业务模块按需 @UseGuards 引入）。 */
@Global()
@Module({
  providers: [
    CryptoService,
    BearerAuthGuard,
    AdminAuthGuard,
    RbacGuard,
  ],
  exports: [
    CryptoService,
    BearerAuthGuard,
    AdminAuthGuard,
    RbacGuard,
  ],
})
export class CommonModule {}
