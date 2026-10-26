import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { gatewayFiles, gatewayProviders, users } from '../db/schema';
import { CryptoService } from '../common/crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/errors/api-error';
import { rfc3339UTC } from '../common/time';

const MAX_FILES_UPLOAD_BODY = 64 * 1024 * 1024;
const MAX_FILES_RESPONSE_BODY = 4 * 1024 * 1024;

function validFileId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,200}$/.test(id);
}

function fileNotFoundMessage(id: string): string {
  return `file_id not found or expired（文件不存在或已过期，请重新上传）: ${id}`;
}

function filesURL(base: string, suffix: string): string {
  let b = base.replace(/\/+$/, '');
  b = b.replace(/\/v1$/, '');
  return `${b}/files${suffix}`;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

interface FileUpstream {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
}

@Injectable()
export class GatewayFilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private async fileUpstream(): Promise<FileUpstream | null> {
    const rows = await this.db
      .select({ id: gatewayProviders.id, name: gatewayProviders.name, baseUrl: gatewayProviders.baseUrl, apiKeyEnc: gatewayProviders.apiKeyEnc })
      .from(gatewayProviders)
      .where(and(eq(gatewayProviders.enabled, 1), or(ilike(gatewayProviders.baseUrl, '%deepseek%'), ilike(gatewayProviders.name, '%deepseek%'))))
      .orderBy(gatewayProviders.id)
      .limit(1);
    if (rows.length === 0) return null;
    const p = rows[0];
    let key = '';
    if (p.apiKeyEnc) {
      try {
        key = this.crypto.decrypt(p.apiKeyEnc);
      } catch {
        key = '';
      }
    }
    return { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: key };
  }

  // ---------------------------------------------------------------------------
  // Client face
  // ---------------------------------------------------------------------------

  async uploadFile(userId: number, raw: Buffer, contentType: string, res: import('express').Response): Promise<void> {
    if (raw.length > MAX_FILES_UPLOAD_BODY) {
      throw new ApiError('VALIDATION', '上传文件超过上限（单文件最大 64 MiB）', 413);
    }
    const up = await this.fileUpstream();
    if (!up) throw new ApiError('SERVER', '未配置可用的 DeepSeek 上游(文件接口仅支持 DeepSeek)', 503);
    const resp = await fetch(filesURL(up.baseUrl, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${up.apiKey}`, 'Content-Type': contentType },
      body: new Uint8Array(raw),
    });
    const text = await resp.text();
    if (!resp.ok) {
      res.status(resp.status).setHeader('Content-Type', 'application/json').end(text);
      return;
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    const fileId = typeof data.id === 'string' ? data.id : '';
    if (fileId) {
      const expiresAt = typeof data.expires_at === 'number' ? new Date(data.expires_at * 1000) : null;
      const sizeBytes = typeof data.bytes === 'number' ? data.bytes : typeof data.size_bytes === 'number' ? data.size_bytes : 0;
      await this.db
        .insert(gatewayFiles)
        .values({ fileId, userId, sizeBytes, expiresAt })
        .onConflictDoNothing();
    }
    res.status(resp.status).setHeader('Content-Type', 'application/json').end(JSON.stringify(data));
  }

  async listFiles(userId: number, query: string, res: import('express').Response): Promise<void> {
    const up = await this.fileUpstream();
    if (!up) throw new ApiError('SERVER', '未配置可用的 DeepSeek 上游(文件接口仅支持 DeepSeek)', 503);
    const url = filesURL(up.baseUrl, '') + (query ? `?${query}` : '');
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${up.apiKey}` } });
    const text = await resp.text();
    if (!resp.ok) {
      res.status(resp.status).setHeader('Content-Type', 'application/json').end(text);
      return;
    }
    let data: { data?: Array<{ id?: string }> } = { data: [] };
    try {
      data = JSON.parse(text);
    } catch {
      data = { data: [] };
    }
    const list = data.data ?? [];
    const ids = list.map((f) => f.id).filter((x): x is string => !!x);
    const owned = await this.ownedIds(userId, ids);
    const filtered = { ...data, data: list.filter((f) => f.id && owned.has(f.id)) };
    res.status(resp.status).setHeader('Content-Type', 'application/json').end(JSON.stringify(filtered));
  }

  async retrieveFile(userId: number, fileId: string, res: import('express').Response): Promise<void> {
    if (!validFileId(fileId)) throw new ApiError('NOT_FOUND', fileNotFoundMessage(fileId));
    const owned = await this.ownedBy(userId, fileId);
    if (!owned) throw new ApiError('NOT_FOUND', fileNotFoundMessage(fileId));
    const up = await this.fileUpstream();
    if (!up) throw new ApiError('SERVER', '未配置可用的 DeepSeek 上游(文件接口仅支持 DeepSeek)', 503);
    const resp = await fetch(filesURL(up.baseUrl, `/${fileId}`), { headers: { Authorization: `Bearer ${up.apiKey}` } });
    res.status(resp.status).setHeader('Content-Type', resp.headers.get('Content-Type') ?? 'application/octet-stream');
    const body = resp.body;
    if (body) {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        res.write(Buffer.from(chunk));
      }
    }
    res.end();
  }

  async deleteFile(userId: number, fileId: string): Promise<{ id: string; object: string; deleted: boolean }> {
    if (!validFileId(fileId)) throw new ApiError('NOT_FOUND', fileNotFoundMessage(fileId));
    const owned = await this.ownedBy(userId, fileId);
    if (!owned) throw new ApiError('NOT_FOUND', fileNotFoundMessage(fileId));
    const up = await this.fileUpstream();
    if (!up) throw new ApiError('SERVER', '未配置可用的 DeepSeek 上游(文件接口仅支持 DeepSeek)', 503);
    const resp = await fetch(filesURL(up.baseUrl, `/${fileId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${up.apiKey}` },
    });
    await resp.body?.cancel().catch(() => undefined);
    if (resp.ok || resp.status === 404) {
      await this.db.delete(gatewayFiles).where(and(eq(gatewayFiles.fileId, fileId), eq(gatewayFiles.userId, userId)));
    }
    return { id: fileId, object: 'file', deleted: resp.ok || resp.status === 404 };
  }

  // ---------------------------------------------------------------------------
  // Admin face
  // ---------------------------------------------------------------------------

  async listGatewayFiles(query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const q = this.parseAdminQuery(query);
    const where = this.fileWhere(q);
    const orderCol = q.sort === 'size_bytes' ? gatewayFiles.sizeBytes : q.sort === 'expires_at' ? gatewayFiles.expiresAt : q.sort === 'username' ? users.username : gatewayFiles.createdAt;
    const rows = await this.db
      .select({
        fileId: gatewayFiles.fileId,
        userId: gatewayFiles.userId,
        username: users.username,
        displayName: users.displayName,
        sizeBytes: gatewayFiles.sizeBytes,
        createdAt: gatewayFiles.createdAt,
        expiresAt: gatewayFiles.expiresAt,
      })
      .from(gatewayFiles)
      .leftJoin(users, eq(gatewayFiles.userId, users.id))
      .where(where)
      .orderBy(q.desc ? desc(orderCol) : orderCol)
      .limit(q.size)
      .offset((q.page - 1) * q.size);
    const total = await this.countWhere(where);
    const totals = await this.totals();
    const now = Date.now();
    return {
      rows: rows.map((r) => ({
        file_id: r.fileId,
        user_id: r.userId,
        username: r.username ?? '',
        display_name: r.displayName ?? '',
        size_bytes: Number(r.sizeBytes),
        created_at: r.createdAt ? rfc3339UTC(new Date(r.createdAt)) : null,
        expires_at: r.expiresAt ? rfc3339UTC(new Date(r.expiresAt)) : null,
        expired: !!r.expiresAt && new Date(r.expiresAt).getTime() <= now,
      })),
      total,
      totals,
    };
  }

  async gatewayFilesSummary(query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const q = this.parseAdminQuery({ ...query, page: 1, size: 200 });
    const where = this.fileWhere(q);
    const rows = await this.db
      .select({
        userId: gatewayFiles.userId,
        username: users.username,
        displayName: users.displayName,
        files: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${gatewayFiles.sizeBytes})::float8, 0)`,
        expiredFiles: sql<number>`count(*) FILTER (WHERE ${gatewayFiles.expiresAt} IS NOT NULL AND ${gatewayFiles.expiresAt} <= now())::int`,
        earliest: sql<Date | null>`min(${gatewayFiles.expiresAt})`,
      })
      .from(gatewayFiles)
      .leftJoin(users, eq(gatewayFiles.userId, users.id))
      .where(where)
      .groupBy(gatewayFiles.userId, users.username, users.displayName)
      .orderBy(desc(sql<number>`coalesce(sum(${gatewayFiles.sizeBytes})::float8, 0)`))
      .limit(q.size);
    const totals = await this.totals();
    return {
      rows: rows.map((r) => ({
        user_id: r.userId,
        username: r.username ?? '',
        display_name: r.displayName ?? '',
        files: r.files,
        bytes: Number(r.bytes),
        expired_files: r.expiredFiles,
        earliest_expires_at: r.earliest ? rfc3339UTC(new Date(r.earliest)) : null,
      })),
      totals,
    };
  }

  async deleteGatewayFile(actor: string, fileId: string): Promise<Record<string, unknown>> {
    if (!validFileId(fileId)) throw new ApiError('NOT_FOUND', fileNotFoundMessage(fileId));
    const exists = await this.db.select({ fileId: gatewayFiles.fileId }).from(gatewayFiles).where(eq(gatewayFiles.fileId, fileId)).limit(1);
    if (exists.length === 0) throw new ApiError('NOT_FOUND', fileNotFoundMessage(fileId));
    const up = await this.fileUpstream();
    if (!up) throw new ApiError('SERVER', '没有可用的文件上游', 503);
    const resp = await fetch(filesURL(up.baseUrl, `/${fileId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${up.apiKey}` },
    });
    await resp.body?.cancel().catch(() => undefined);
    if (resp.ok || resp.status === 404) {
      await this.db.delete(gatewayFiles).where(eq(gatewayFiles.fileId, fileId));
      await this.audit.log(actor, 'gateway_file_delete', `file_id=${fileId}`);
      return { ok: true, deleted: 1 };
    }
    throw new ApiError('UPSTREAM', '上游删除失败', 502);
  }

  async purgeGatewayFiles(actor: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const username = typeof body.user === 'string' && body.user ? body.user : undefined;
    const userId = typeof body.user_id === 'number' && body.user_id > 0 ? body.user_id : undefined;
    if (typeof body.user_id === 'number' && body.user_id <= 0) {
      throw new ApiError('VALIDATION', 'user_id 必须是正整数（用户名请用 user）');
    }
    let state = typeof body.state === 'string' ? body.state : 'all';
    if (body.expired_only === true) state = 'expired';
    if (!['active', 'expired', 'all'].includes(state)) {
      throw new ApiError('VALIDATION', 'state 只支持 active|expired|all');
    }
    if (!username && !userId && state === 'all') {
      throw new ApiError('VALIDATION', '必须指定 user 或 state（避免误清全量台账）');
    }
    if (state === 'active' && !username && !userId) {
      throw new ApiError('VALIDATION', '清理仍然有效的文件必须指定员工（user 或 user_id）；全组织范围只允许清理已过期文件');
    }
    const limit = typeof body.limit === 'number' && body.limit >= 1 && body.limit <= 500 ? Math.floor(body.limit) : 500;

    let resolvedUserId: number | undefined = userId;
    if (username && !userId) {
      const u = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
      if (u.length === 0) throw new ApiError('VALIDATION', 'user 必须是存在的用户名（数字 ID 请用 user_id）');
      resolvedUserId = u[0].id;
    }

    const where = this.purgeWhere(resolvedUserId, state);
    const candidates = await this.db
      .select({ fileId: gatewayFiles.fileId })
      .from(gatewayFiles)
      .where(where)
      .orderBy(gatewayFiles.createdAt)
      .limit(limit);
    if (candidates.length === 0) {
      return { ok: true, deleted: 0, skipped: 0, failed: 0, matched: 0 };
    }
    const up = await this.fileUpstream();
    if (!up) throw new ApiError('SERVER', '没有可用的文件上游', 503);

    let deleted = 0;
    let failed = 0;
    let skipped = 0;
    for (const c of candidates) {
      const resp = await fetch(filesURL(up.baseUrl, `/${c.fileId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${up.apiKey}` },
      });
      await resp.body?.cancel().catch(() => undefined);
      if (resp.ok || resp.status === 404) {
        await this.db.delete(gatewayFiles).where(eq(gatewayFiles.fileId, c.fileId));
        deleted++;
      } else {
        failed++;
      }
    }
    await this.audit.log(actor, 'gateway_file_purge', `deleted=${deleted} skipped=${skipped} failed=${failed} matched=${candidates.length}`);
    return { ok: true, deleted, skipped, failed, matched: candidates.length };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async ownedBy(userId: number, fileId: string): Promise<boolean> {
    const rows = await this.db
      .select({ fileId: gatewayFiles.fileId })
      .from(gatewayFiles)
      .where(and(eq(gatewayFiles.fileId, fileId), eq(gatewayFiles.userId, userId), or(sql`${gatewayFiles.expiresAt} IS NULL`, sql`${gatewayFiles.expiresAt} > now()`)))
      .limit(1);
    return rows.length > 0;
  }

  private async ownedIds(userId: number, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const owned = new Set<string>();
    const chunk = 5000;
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      const rows = await this.db
        .select({ fileId: gatewayFiles.fileId })
        .from(gatewayFiles)
        .where(and(eq(gatewayFiles.userId, userId), inArray(gatewayFiles.fileId, slice), or(sql`${gatewayFiles.expiresAt} IS NULL`, sql`${gatewayFiles.expiresAt} > now()`)));
      for (const r of rows) owned.add(r.fileId);
    }
    return owned;
  }

  private parseAdminQuery(query: Record<string, unknown>): {
    userId: number | undefined;
    search: string | undefined;
    state: 'active' | 'expired' | 'all';
    sort: string;
    desc: boolean;
    size: number;
    page: number;
  } {
    const userId = typeof query.user_id === 'number' && query.user_id > 0 ? query.user_id : undefined;
    let state: 'active' | 'expired' | 'all' = 'all';
    if (typeof query.state === 'string') {
      if (query.state === 'active' || query.state === 'expired' || query.state === 'all') state = query.state;
      else throw new ApiError('VALIDATION', 'state 只支持 active|expired|all');
    }
    const search = typeof query.q === 'string' && query.q ? query.q : undefined;
    const sort = typeof query.sort === 'string' && ['created_at', 'expires_at', 'size_bytes', 'username'].includes(query.sort) ? query.sort : 'created_at';
    const desc = query.order !== 'asc';
    const size = typeof query.size === 'number' && query.size >= 1 && query.size <= 200 ? Math.floor(query.size) : 50;
    const page = typeof query.page === 'number' && query.page >= 1 ? Math.floor(query.page) : 1;
    return { userId, search, state, sort, desc, size, page };
  }

  private fileWhere(q: ReturnType<GatewayFilesService['parseAdminQuery']>) {
    const conds = [];
    if (q.userId !== undefined) conds.push(eq(gatewayFiles.userId, q.userId));
    if (q.search) conds.push(ilike(gatewayFiles.fileId, `%${q.search.replace(/[%_\\]/g, '\\$&')}%`));
    if (q.state === 'expired') conds.push(sql`${gatewayFiles.expiresAt} <= now()`);
    else if (q.state === 'active') conds.push(sql`${gatewayFiles.expiresAt} > now()`);
    return conds.length ? and(...conds) : undefined;
  }

  private purgeWhere(userId: number | undefined, state: string) {
    const conds = [];
    if (userId !== undefined) conds.push(eq(gatewayFiles.userId, userId));
    if (state === 'expired') conds.push(sql`${gatewayFiles.expiresAt} <= now()`);
    else if (state === 'active') conds.push(sql`${gatewayFiles.expiresAt} > now()`);
    return conds.length ? and(...conds) : undefined;
  }

  private async countWhere(where: ReturnType<GatewayFilesService['fileWhere']>): Promise<number> {
    const rows = await this.db.select({ c: sql<number>`count(*)::int` }).from(gatewayFiles).where(where);
    return rows[0]?.c ?? 0;
  }

  private async totals(): Promise<{ files: number; bytes: number; expired: number }> {
    const rows = await this.db
      .select({
        files: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${gatewayFiles.sizeBytes})::float8, 0)`,
        expired: sql<number>`count(*) FILTER (WHERE ${gatewayFiles.expiresAt} IS NOT NULL AND ${gatewayFiles.expiresAt} <= now())::int`,
      })
      .from(gatewayFiles);
    const r = rows[0];
    return { files: r?.files ?? 0, bytes: Number(r?.bytes ?? 0), expired: r?.expired ?? 0 };
  }
}
