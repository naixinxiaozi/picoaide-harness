import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { connectors, type Connector } from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { rfc3339UTC } from '../common/time';

export interface ConnectorJSON {
  id: string;
  name: string;
  description: string;
  auth_mode: string;
  definition: string;
  enabled: boolean;
  updated_at: string;
  created_at: string;
}

const MAX_DEFINITION_BYTES = 64 * 1024; // 64 KiB
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AUTH_MODES = new Set(['oauth', 'device', 'token', 'server-side', 'auto']);

@Injectable()
export class ConnectorsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private toJSON(c: Connector): ConnectorJSON {
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      auth_mode: c.authMode,
      definition: c.definition,
      enabled: c.enabled === 1,
      updated_at: rfc3339UTC(c.updatedAt),
      created_at: rfc3339UTC(c.createdAt),
    };
  }

  /** 校验定义 JSON（含 mcp 数组，每项含合法 serverName）。 */
  private validateDefinition(def: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(def);
    } catch {
      throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
    }
    if (parsed == null || typeof parsed !== 'object') {
      throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
    }
    const mcp = (parsed as Record<string, unknown>).mcp;
    if (!Array.isArray(mcp) || mcp.length === 0) {
      throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
    }
    for (const item of mcp) {
      if (item == null || typeof item !== 'object') {
        throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
      }
      const serverName = (item as Record<string, unknown>).serverName;
      if (typeof serverName !== 'string' || !SERVER_NAME_RE.test(serverName)) {
        throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
      }
    }
  }

  private validate(body: {
    id: string;
    name: string;
    auth_mode: string;
    definition: string;
  }): void {
    if (!CONNECTOR_ID_RE.test(body.id)) {
      throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
    }
    if (!body.name || body.name.trim() === '') {
      throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
    }
    if (!AUTH_MODES.has(body.auth_mode)) {
      throw new ApiError('VALIDATION', '连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)', 400);
    }
    if (Buffer.byteLength(body.definition, 'utf8') > MAX_DEFINITION_BYTES) {
      throw new ApiError('VALIDATION', '定义 JSON 过长', 400);
    }
    this.validateDefinition(body.definition);
  }

  async list(): Promise<ConnectorJSON[]> {
    const rows = await this.db.select().from(connectors).orderBy(connectors.id);
    return rows.map((c) => this.toJSON(c));
  }

  async get(id: string): Promise<ConnectorJSON> {
    const [row] = await this.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '连接器不存在');
    return this.toJSON(row);
  }

  async create(
    body: {
      id?: string;
      name?: string;
      description?: string;
      auth_mode?: string;
      definition?: string;
      enabled?: boolean;
    },
    username: string,
  ): Promise<ConnectorJSON> {
    const id = (body?.id ?? '').trim();
    const name = (body?.name ?? '').trim();
    const description = (body?.description ?? '').trim();
    const authMode = body?.auth_mode ?? '';
    const definition = body?.definition ?? '';
    const enabled = body?.enabled === undefined ? true : body.enabled;

    this.validate({ id, name, auth_mode: authMode, definition });

    const [dup] = await this.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    if (dup) throw new ApiError('CONFLICT', '连接器 id 已存在');

    const [row] = await this.db
      .insert(connectors)
      .values({
        id,
        name,
        description,
        authMode: authMode as Connector['authMode'],
        definition,
        enabled: enabled ? 1 : 0,
      })
      .returning();
    await this.audit.log(username, 'connector_create', id);
    return this.toJSON(row);
  }

  async update(
    id: string,
    body: {
      name?: string;
      description?: string;
      auth_mode?: string;
      definition?: string;
      enabled?: boolean;
    },
    username: string,
  ): Promise<ConnectorJSON> {
    const [cur] = await this.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    if (!cur) throw new ApiError('NOT_FOUND', '连接器不存在');

    const name = (body?.name ?? '').trim();
    const description = (body?.description ?? '').trim();
    const authMode = body?.auth_mode ?? cur.authMode;
    const definition = body?.definition ?? cur.definition;
    // PATCH 语义：body 省略 enabled 时保持现值。
    const enabled = body?.enabled === undefined ? cur.enabled === 1 : body.enabled;

    this.validate({ id, name, auth_mode: authMode, definition });

    const [row] = await this.db
      .update(connectors)
      .set({
        name,
        description,
        authMode: authMode as Connector['authMode'],
        definition,
        enabled: enabled ? 1 : 0,
        updatedAt: new Date(),
      })
      .where(eq(connectors.id, id))
      .returning();
    await this.audit.log(username, 'connector_update', id);
    return this.toJSON(row);
  }

  async setEnabled(
    id: string,
    body: { enabled?: boolean },
    username: string,
  ): Promise<void> {
    if (body == null || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
      throw new ApiError('VALIDATION', '缺少 enabled 字段', 400);
    }
    const [row] = await this.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '连接器不存在');
    await this.db
      .update(connectors)
      .set({ enabled: body.enabled ? 1 : 0, updatedAt: new Date() })
      .where(eq(connectors.id, id));
    await this.audit.log(username, 'connector_enabled', id);
  }

  async remove(id: string, username: string): Promise<void> {
    const [row] = await this.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '连接器不存在');
    await this.db.delete(connectors).where(eq(connectors.id, id));
    await this.audit.log(username, 'connector_delete', id);
  }
}
