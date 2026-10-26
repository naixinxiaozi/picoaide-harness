import { Body, Controller, Param, Put, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { Inject } from '@nestjs/common';
import { DRIZZLE, type Database } from '../db/database.module';
import { users, type AppKind } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/errors/api-error';
import { getApp, setAppOfficial } from '../common/apps-shared';
import { isAppId } from '../common/skills-shared';

/**
 * 统一应用模型的管理端点：归属转移 / 归属官方（Go internal/appstore/admin.go）。
 * owner 是 (kind, app_id) 级属性，与版本无关，故挂在 apps 基路径。
 */
@Controller('api/server/admin/apps')
@UseGuards(AdminAuthGuard, RbacGuard)
export class AppstoreAdminController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  @Put(':kind/:appId/owner')
  @Permissions('capability:write')
  async transferOwner(
    @Param('kind') kind: string,
    @Param('appId') appId: string,
    @Body() body: { owner?: string; official?: boolean },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    if (kind !== 'skill' && kind !== 'agent') {
      throw new ApiError('VALIDATION', '类型不合法:只能是 skill 或 agent', 400);
    }
    if (!isAppId(appId)) {
      throw new ApiError('VALIDATION', '名称不合法:必须是小写 kebab-case(如 my-skill)', 400);
    }
    const owner = (body?.owner ?? '').trim();
    const official = body?.official;
    if ((owner !== '' && official !== undefined) || (owner === '' && official === undefined)) {
      throw new ApiError('VALIDATION', 'owner 与 official 必须指定其一', 400);
    }
    const app = await getApp(this.db, kind as AppKind, appId);
    if (!app) throw new ApiError('NOT_FOUND', '能力不存在', 404);

    if (official !== undefined) {
      if (!official) {
        throw new ApiError(
          'VALIDATION',
          'official 只接受 true;取消官方归属请用 owner 指定新负责人',
          400,
        );
      }
      if (app.official === 1 && app.owner === '') {
        return { ok: true, official: true };
      }
      await setAppOfficial(this.db, kind as AppKind, appId, true, '');
      await this.audit.log(
        admin.username,
        'app_owner_transfer',
        this.detail(kind, appId, app.title, app.owner, '官方'),
        appId,
      );
      return { ok: true, official: true };
    }

    const target = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, owner))
      .limit(1);
    if (target.length === 0) {
      throw new ApiError('VALIDATION', '目标用户不存在', 400);
    }
    if (app.owner === owner && app.official === 0) {
      return { ok: true, owner };
    }
    await setAppOfficial(this.db, kind as AppKind, appId, false, owner);
    const from = app.official === 1 ? '官方' : app.owner;
    await this.audit.log(
      admin.username,
      'app_owner_transfer',
      this.detail(kind, appId, app.title, from, owner),
      appId,
    );
    return { ok: true, owner };
  }

  private detail(kind: string, appId: string, title: string, from: string, to: string): string {
    let out = `${kind}:${appId}`;
    if (title !== '') out += ` 「${title}」`;
    return `${out} 归属 ${from} → ${to}`;
  }
}
