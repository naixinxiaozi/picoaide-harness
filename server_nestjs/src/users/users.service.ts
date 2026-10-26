import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { users, type User } from '../db/schema';
import { quantizeMoney } from '../common/money';
import { permissionsOf, type AdminRole } from '../common/rbac/permissions';

/** 客户端/管理端共用的用户 JSON 形状（与 Go userJSON 逐字段对齐）。 */
export interface UserJSON {
  id: number;
  username: string;
  display_name: string;
  email: string;
  is_admin: boolean;
  role: string;
  permissions: string[];
  status: number;
  balance_money: number;
  balance_activated: boolean;
  source: string;
  password_changeable: boolean;
  password_must_change: boolean;
  password_changed_at: string;
  mfa_enabled: boolean;
}

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** 按用户名查找（服务层 lowercase，等价原库 NOCASE 唯一索引）。 */
  async findByUsername(username: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username.toLowerCase()))
      .limit(1);
    return row;
  }

  async findById(id: number): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row;
  }

  /** 序列化为契约 JSON（is_admin/password_must_change/mfa_enabled 均为 bool）。 */
  toUserJSON(user: User): UserJSON {
    return {
      id: user.id,
      username: user.username,
      display_name: user.displayName ?? '',
      email: user.email ?? '',
      is_admin: user.isAdmin === 1,
      role: user.role,
      permissions: [...permissionsOf(user.role as AdminRole)],
      status: user.status,
      balance_money: quantizeMoney(user.balanceMoney),
      balance_activated: user.balanceActivatedAt != null,
      source: user.source,
      password_changeable:
        user.source === 'local' && !!user.passwordHash && user.status === 1,
      password_must_change: user.passwordMustChange === 1,
      password_changed_at: user.passwordChangedAt
        ? user.passwordChangedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')
        : '0001-01-01T00:00:00Z',
      mfa_enabled: user.totpEnabled === 1,
    };
  }
}
