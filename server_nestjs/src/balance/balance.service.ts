import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/database.module';
import {
  balanceGrantItems,
  balanceGrants,
  balanceLedger,
  users,
  type LedgerKind,
} from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { quantizeMoney, roundMicro, roundMoney } from '../common/money';
import { beijingMonthKey } from '../common/time';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';

const KEY_ENABLED = 'balance.enabled';
const KEY_AMOUNT = 'balance.monthly_amount';
const KEY_MODE = 'balance.monthly_mode';

const MAX_BALANCE_AMOUNT = 1e8;
const MONEY_EPSILON = 0.0001;
const GRANT_BATCH_SIZE = 500;

export interface BalanceSettings {
  enabled: boolean;
  monthly_amount: number;
  monthly_mode: string;
}

export interface BalanceGrant {
  month: string;
  mode: string;
  amount: number;
  affected: number;
  actor: string;
  created_at: string;
}

export interface GrantRun {
  month: string;
  mode: string;
  amount: number;
  granted: number;
  skipped: number;
  actor: string;
  cover_debt_users: number;
  cover_debt_amount: number;
}

export interface GrantStatus {
  month: string;
  eligible: number;
  granted: number;
  pending: number;
  activated: number;
  last_grant: BalanceGrant | null;
}

export interface BalanceLedgerEntry {
  id: number;
  user_id: number;
  kind: string;
  amount: number;
  balance_after: number;
  reason: string;
  actor: string;
  usage_id: number | null;
  month: string;
  created_at: string;
}

export interface BalanceSummary {
  settings: BalanceSettings;
  last_grant: BalanceGrant | null;
  month_grant: BalanceGrant | null;
  status: GrantStatus;
  users: number;
  total_balance: number;
  overdrawn_users: number;
  overdrawn_debt: number;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class BalanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private moneyStr(v: number): string {
    return String(roundMoney(v));
  }

  private parseAmount(v: string | null): number {
    if (v === null) return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return roundMoney(n);
  }

  async getSettings(): Promise<BalanceSettings> {
    const map = await this.settings.getMany([KEY_ENABLED, KEY_AMOUNT, KEY_MODE]);
    const enabled = (map.get(KEY_ENABLED) ?? '').trim() === 'true' || (map.get(KEY_ENABLED) ?? '').trim() === '1';
    const amount = this.parseAmount(map.get(KEY_AMOUNT) ?? null);
    const mode = (map.get(KEY_MODE) ?? '').trim() === 'cover' ? 'cover' : 'add';
    return { enabled, monthly_amount: amount, monthly_mode: mode };
  }

  async adjust(
    userId: number,
    mode: string,
    amount: number | undefined,
    reason: string,
    actor: string,
  ): Promise<{ user_id: number; balance_money: number }> {
    const user = await this.db
      .select({ username: users.username, balanceMoney: users.balanceMoney })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (user.length === 0) throw new ApiError('NOT_FOUND', '用户不存在', 404);
    const username = user[0].username;
    const old = quantizeMoney(user[0].balanceMoney);

    if (Array.from(reason).length > 200) throw new ApiError('VALIDATION', '备注最多 200 字', 400);

    const m = mode === '' ? 'add' : mode;
    if (!['add', 'deduct', 'set', 'clear'].includes(m)) {
      throw new ApiError('VALIDATION', 'mode 只能是 add/deduct/set/clear', 400);
    }

    let target: number;
    if (m === 'clear') {
      target = 0;
    } else {
      if (amount === undefined || amount === null) {
        throw new ApiError(
          'VALIDATION',
          '缺少 amount:若要清零请用 mode=clear,set 必须显式给出金额(0 也合法)',
          400,
        );
      }
      if (!Number.isFinite(amount)) throw new ApiError('VALIDATION', '金额必须是有限数值', 400);
      if (m !== 'clear' && amount > MAX_BALANCE_AMOUNT) throw new ApiError('VALIDATION', '金额不能超过 1 亿元', 400);
      if (m !== 'set' && m !== 'clear' && amount <= 0) throw new ApiError('VALIDATION', '金额必须大于 0', 400);
      if (m === 'set' && amount < 0) throw new ApiError('VALIDATION', '金额不能为负数', 400);
      target = amount;
    }

    const next = await this.db.transaction(async (tx) => {
      let delta: number;
      if (m === 'add' || m === 'deduct') {
        let d = m === 'add' ? roundMoney(target) : -roundMoney(target);
        const rows = await tx
          .select({ balanceMoney: users.balanceMoney })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (rows.length === 0) throw new ApiError('NOT_FOUND', '用户不存在', 404);
        const current = rows[0].balanceMoney;
        if (d < 0) {
          if (-d > quantizeMoney(current) + MONEY_EPSILON) {
            throw new ApiError('VALIDATION', '扣减金额超过当前余额(如需归零请用「清零」)', 400);
          }
          if (-d >= current) d = -roundMicro(current);
        }
        delta = d;
        return this.applyDelta(tx, userId, delta, reason, actor);
      }
      // set / clear
      const targetRounded = roundMoney(target);
      if (targetRounded < 0 || !Number.isFinite(targetRounded)) {
        throw new ApiError('VALIDATION', '金额不能为负数', 400);
      }
      const rows = await tx
        .select({ balanceMoney: users.balanceMoney })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (rows.length === 0) throw new ApiError('NOT_FOUND', '用户不存在', 404);
      const current = rows[0].balanceMoney;
      delta = roundMicro(targetRounded - current);
      return this.applyDelta(tx, userId, delta, reason, actor);
    });

    const balanceMoney = quantizeMoney(next);
    let detail = `${username}(#${userId}): ${old.toFixed(2)}→${balanceMoney.toFixed(2)} mode=${m}`;
    if (reason !== '') detail += ` reason=${reason}`;
    await this.audit.log(actor, 'balance_adjust', detail);

    return { user_id: userId, balance_money: balanceMoney };
  }

  private async applyDelta(tx: Tx, userId: number, delta: number, reason: string, actor: string): Promise<number> {
    const d = roundMicro(delta);
    if (d === 0) {
      const rows = await tx
        .select({ balanceMoney: users.balanceMoney })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.balanceMoney ?? 0;
    }
    const updated = await tx
      .update(users)
      .set({
        balanceMoney: sql`${users.balanceMoney} + ${d}`,
        balanceActivatedAt: sql`COALESCE(${users.balanceActivatedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ balanceMoney: users.balanceMoney });
    const after = updated[0].balanceMoney;
    await tx.insert(balanceLedger).values({
      userId,
      kind: 'adjust',
      amount: d,
      balanceAfter: roundMicro(after),
      reason,
      actor,
      usageId: null,
      month: '',
    });
    return after;
  }

  async ledger(
    userId: number,
    kind: string | undefined,
    page: number,
    size: number,
  ): Promise<{ items: BalanceLedgerEntry[]; total: number; ledger_sum: number; balance_money: number }> {
    const p = page < 1 ? 1 : page;
    const s = size < 1 || size > 200 ? 20 : size;
    const offset = (p - 1) * s;

    const conds = [eq(balanceLedger.userId, userId)];
    if (kind) conds.push(eq(balanceLedger.kind, kind as LedgerKind));

    const totalRows = await this.db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(balanceLedger)
      .where(and(...conds));
    const total = Number(totalRows[0].c);

    const rows = await this.db
      .select({
        id: balanceLedger.id,
        userId: balanceLedger.userId,
        kind: balanceLedger.kind,
        amount: balanceLedger.amount,
        balanceAfter: balanceLedger.balanceAfter,
        reason: balanceLedger.reason,
        actor: balanceLedger.actor,
        usageId: balanceLedger.usageId,
        month: balanceLedger.month,
        createdAt: balanceLedger.createdAt,
      })
      .from(balanceLedger)
      .where(and(...conds))
      .orderBy(desc(balanceLedger.id))
      .limit(s)
      .offset(offset);

    const items: BalanceLedgerEntry[] = rows.map((r) => ({
      id: r.id,
      user_id: r.userId,
      kind: r.kind,
      amount: r.amount,
      balance_after: r.balanceAfter,
      reason: r.reason,
      actor: r.actor,
      usage_id: r.usageId,
      month: r.month,
      created_at: r.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }));

    const sumRows = await this.db.execute<{ s: number }>(
      sql`SELECT COALESCE(SUM(amount), 0)::float8 AS s FROM balance_ledger WHERE user_id = ${userId}`,
    );
    const ledgerSum = Number(sumRows[0].s);

    const userRows = await this.db
      .select({ balanceMoney: users.balanceMoney })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const balanceMoney = userRows[0]?.balanceMoney ?? 0;

    return {
      items,
      total,
      ledger_sum: quantizeMoney(ledgerSum),
      balance_money: quantizeMoney(balanceMoney),
    };
  }

  async summary(): Promise<BalanceSummary> {
    const settings = await this.getSettings();
    const now = new Date();
    const month = beijingMonthKey(now);

    const lastGrant = await this.lastGrant();
    const monthGrant = await this.grantByMonth(month);
    const status = await this.grantStatus(now, lastGrant);

    const userRows = await this.db.execute<{ c: number; s: number }>(
      sql`SELECT COUNT(*)::int AS c, COALESCE(SUM(balance_money), 0)::float8 AS s FROM users WHERE status = 1 AND role = 'user'`,
    );
    const overdrawnRows = await this.db.execute<{ c: number; s: number }>(
      sql`SELECT COUNT(*)::int AS c, COALESCE(-SUM(balance_money), 0)::float8 AS s FROM users WHERE status = 1 AND role = 'user' AND balance_money < 0`,
    );

    return {
      settings,
      last_grant: lastGrant,
      month_grant: monthGrant,
      status,
      users: Number(userRows[0].c),
      total_balance: quantizeMoney(Number(userRows[0].s)),
      overdrawn_users: Number(overdrawnRows[0].c),
      overdrawn_debt: quantizeMoney(Number(overdrawnRows[0].s)),
    };
  }

  async putSettings(
    enabled: boolean,
    monthlyAmount: number,
    monthlyMode: string,
    actor: string,
  ): Promise<{ ok: boolean; settings: BalanceSettings; auto_grant: boolean; run: GrantRun | null }> {
    if (monthlyAmount < 0 || monthlyAmount > MAX_BALANCE_AMOUNT) {
      throw new ApiError('VALIDATION', '月度额度必须在 0 ~ 1 亿元之间', 400);
    }
    if (monthlyMode !== 'add' && monthlyMode !== 'cover') {
      throw new ApiError('VALIDATION', '发放模式只能是 add 或 cover', 400);
    }

    await this.settings.set(KEY_ENABLED, enabled ? 'true' : 'false');
    await this.settings.set(KEY_AMOUNT, this.moneyStr(monthlyAmount));
    await this.settings.set(KEY_MODE, monthlyMode);
    await this.audit.log(actor, 'balance_settings', `enabled=${enabled} amount=${roundMoney(monthlyAmount).toFixed(2)} mode=${monthlyMode}`);

    let run: GrantRun | null = null;
    if (monthlyAmount > 0) {
      run = await this.grantMonthly(monthlyMode, monthlyAmount, actor, new Date(), 0);
      if (run.granted > 0) {
        await this.audit.log(
          actor,
          'balance_grant',
          `auto month=${run.month} mode=${run.mode} amount=${roundMoney(run.amount).toFixed(2)} granted=${run.granted}`,
        );
      }
    }

    return {
      ok: true,
      settings: await this.getSettings(),
      auto_grant: run !== null && run.granted > 0,
      run,
    };
  }

  async grant(actor: string): Promise<{ ok: boolean; already: boolean; run: GrantRun }> {
    const settings = await this.getSettings();
    if (settings.monthly_amount <= 0) {
      throw new ApiError('VALIDATION', '请先配置大于 0 的月度额度', 400);
    }
    let run: GrantRun;
    try {
      run = await this.grantMonthly(settings.monthly_mode, settings.monthly_amount, actor, new Date(), 0);
    } catch {
      throw new ApiError('INTERNAL', '发放失败', 500);
    }
    if (run.granted > 0) {
      await this.audit.log(
        actor,
        'balance_grant',
        `month=${run.month} mode=${run.mode} amount=${roundMoney(run.amount).toFixed(2)} granted=${run.granted}`,
      );
    }
    return { ok: true, already: run.granted === 0, run };
  }

  private normalizeMode(mode: string): string {
    return mode === 'cover' ? 'cover' : 'add';
  }

  private async grantMonthly(
    mode: string,
    amount: number,
    actor: string,
    now: Date,
    onlyUserId: number,
  ): Promise<GrantRun> {
    if (amount <= 0) throw new ApiError('VALIDATION', '金额必须大于 0', 400);
    const m = this.normalizeMode(mode);
    const amt = roundMoney(amount);
    const month = beijingMonthKey(now);

    const skippedRows = await this.db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM users u
      WHERE u.status = 1 AND u.role = 'user' ${onlyUserId > 0 ? sql`AND u.id = ${onlyUserId}` : sql``}
        AND EXISTS (SELECT 1 FROM balance_grant_items i WHERE i.user_id = u.id AND i.month = ${month})
    `);
    const skipped = Number(skippedRows[0].c);

    const claimed = await this.db.execute<{ user_id: number }>(sql`
      INSERT INTO balance_grant_items(user_id, month, amount, mode, actor)
      SELECT id, ${month}, ${amt}, ${m}, ${actor} FROM users
      WHERE status = 1 AND role = 'user' ${onlyUserId > 0 ? sql`AND id = ${onlyUserId}` : sql``}
      ON CONFLICT(user_id, month) DO NOTHING
      RETURNING user_id
    `);
    const ids = claimed.map((c) => Number(c.user_id));

    let coverDebtUsers = 0;
    let coverDebtAmount = 0;
    for (let i = 0; i < ids.length; i += GRANT_BATCH_SIZE) {
      const chunk = ids.slice(i, i + GRANT_BATCH_SIZE);
      const r = await this.grantBatch(chunk, m, amt, actor, month);
      coverDebtUsers += r.coverDebtUsers;
      coverDebtAmount += r.coverDebtAmount;
    }

    await this.db.execute(sql`
      INSERT INTO balance_grants(month, mode, amount, actor, affected)
      VALUES (${month}, ${m}, ${amt}, ${actor}, ${ids.length + skipped})
      ON CONFLICT(month) DO UPDATE SET
        affected = EXCLUDED.affected,
        mode = EXCLUDED.mode,
        amount = EXCLUDED.amount,
        actor = EXCLUDED.actor
    `);

    return {
      month,
      mode: m,
      amount: amt,
      granted: ids.length,
      skipped,
      actor,
      cover_debt_users: coverDebtUsers,
      cover_debt_amount: quantizeMoney(coverDebtAmount),
    };
  }

  private async grantBatch(
    ids: number[],
    mode: string,
    amount: number,
    actor: string,
    month: string,
  ): Promise<{ coverDebtUsers: number; coverDebtAmount: number }> {
    return this.db.transaction(async (tx) => {
      if (mode === 'cover') {
        const rows = await tx
          .select({ id: users.id, balanceMoney: users.balanceMoney })
          .from(users)
          .where(inArray(users.id, ids))
          .for('update');
        let coverDebtUsers = 0;
        let coverDebtAmount = 0;
        for (const r of rows) {
          const old = roundMicro(r.balanceMoney);
          if (old !== 0) {
            await tx.insert(balanceLedger).values({
              userId: r.id,
              kind: 'reset',
              amount: -old,
              balanceAfter: 0,
              reason: '月度发放(覆盖重置)',
              actor,
              usageId: null,
              month,
            });
          }
          if (old < 0) {
            coverDebtUsers += 1;
            coverDebtAmount += -old;
          }
        }
        await tx
          .update(users)
          .set({
            balanceMoney: amount,
            balanceActivatedAt: sql`COALESCE(${users.balanceActivatedAt}, now())`,
            updatedAt: sql`now()`,
          })
          .where(inArray(users.id, ids));
        for (const r of rows) {
          await tx.insert(balanceLedger).values({
            userId: r.id,
            kind: 'grant',
            amount,
            balanceAfter: amount,
            reason: '月度发放(覆盖重置)',
            actor,
            usageId: null,
            month,
          });
        }
        return { coverDebtUsers, coverDebtAmount };
      }
      // add
      const updated = await tx
        .update(users)
        .set({
          balanceMoney: sql`${users.balanceMoney} + ${amount}`,
          balanceActivatedAt: sql`COALESCE(${users.balanceActivatedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(inArray(users.id, ids))
        .returning({ id: users.id, balanceMoney: users.balanceMoney });
      for (const r of updated) {
        await tx.insert(balanceLedger).values({
          userId: r.id,
          kind: 'grant',
          amount,
          balanceAfter: r.balanceMoney,
          reason: '月度发放',
          actor,
          usageId: null,
          month,
        });
      }
      return { coverDebtUsers: 0, coverDebtAmount: 0 };
    });
  }

  private async lastGrant(): Promise<BalanceGrant | null> {
    const rows = await this.db
      .select({
        month: balanceGrants.month,
        mode: balanceGrants.mode,
        amount: balanceGrants.amount,
        affected: balanceGrants.affected,
        actor: balanceGrants.actor,
        createdAt: balanceGrants.createdAt,
      })
      .from(balanceGrants)
      .orderBy(desc(balanceGrants.month))
      .limit(1);
    if (rows.length === 0) return null;
    return this.mapGrant(rows[0]);
  }

  private async grantByMonth(month: string): Promise<BalanceGrant | null> {
    const rows = await this.db
      .select({
        month: balanceGrants.month,
        mode: balanceGrants.mode,
        amount: balanceGrants.amount,
        affected: balanceGrants.affected,
        actor: balanceGrants.actor,
        createdAt: balanceGrants.createdAt,
      })
      .from(balanceGrants)
      .where(eq(balanceGrants.month, month))
      .limit(1);
    if (rows.length === 0) return null;
    return this.mapGrant(rows[0]);
  }

  private mapGrant(r: {
    month: string;
    mode: string;
    amount: number;
    affected: number;
    actor: string;
    createdAt: Date;
  }): BalanceGrant {
    return {
      month: r.month,
      mode: r.mode,
      amount: r.amount,
      affected: r.affected,
      actor: r.actor,
      created_at: r.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  private async grantStatus(now: Date, lastGrant: BalanceGrant | null): Promise<GrantStatus> {
    const month = beijingMonthKey(now);
    const rows = await this.db.execute<{ eligible: number; granted: number; activated: number }>(sql`
      SELECT
        COUNT(*)::int AS eligible,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM balance_grant_items i WHERE i.user_id = u.id AND i.month = ${month}))::int AS granted,
        COUNT(*) FILTER (WHERE u.balance_activated_at IS NOT NULL)::int AS activated
      FROM users u
      WHERE u.status = 1 AND u.role = 'user'
    `);
    const eligible = Number(rows[0].eligible);
    const granted = Number(rows[0].granted);
    return {
      month,
      eligible,
      granted,
      pending: eligible - granted,
      activated: Number(rows[0].activated),
      last_grant: lastGrant,
    };
  }
}
