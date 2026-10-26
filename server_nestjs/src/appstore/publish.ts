import { sql } from 'drizzle-orm';
import type { Database } from '../db/database.module';
import { ApiError } from '../common/errors/api-error';
import { isAppId, isVersion } from '../common/skills-shared';

/**
 * 统一发布内核（镜像 server/internal/appstore/publish.go）。
 *
 * 是所有内容写入口的**唯一**实现：管理后台上架、能力中心上传、智能体预设上传
 * 都走这里，因此版本语义、归属保护、上下架冻结、官方锁定、能力锁定与待审配额
 * 只需实现一次。
 *
 * 版本语义（决策 D1/D3）——判据是「该 App 的全部历史版本」，被拒与软删的版本
 * 同样占位，版本号一经使用即永久不可复用：
 *  1. 同版本号已存在            → 409 VERSION_EXISTS
 *  2. 内容与本人已提交版本相同  → 409 CONTENT_UNCHANGED
 *  3. 新版本号必须严格大于最高  → 409 VERSION_NOT_INCREASING
 *
 * 并发：按 (kind, app_id) 取**事务级**咨询锁（`pg_try_advisory_xact_lock`），
 * 抢不到立刻回滚、退避重试（等待者不占连接），10s 预算用尽 → 503 PUBLISH_BUSY。
 */

export const CODE_VERSION_EXISTS = 'VERSION_EXISTS';
export const CODE_VERSION_NOT_INCREASING = 'VERSION_NOT_INCREASING';
export const CODE_CONTENT_UNCHANGED = 'CONTENT_UNCHANGED';
export const CODE_APP_LOCKED = 'APP_LOCKED';
export const CODE_OFFICIAL_LOCKED = 'OFFICIAL_LOCKED';
export const CODE_NAME_TAKEN = 'NAME_TAKEN';
export const CODE_PENDING_LIMIT = 'PENDING_LIMIT';
export const CODE_APP_DELISTED = 'APP_DELISTED';
export const CODE_PUBLISH_BUSY = 'PUBLISH_BUSY';
export const CODE_INVALID_APP_ID = 'INVALID_APP_ID';
export const CODE_INVALID_VERSION = 'INVALID_VERSION';
export const CODE_MANIFEST_MISMATCH = 'MANIFEST_MISMATCH';
export const CODE_MISSING_FIELD = 'MISSING_FIELD';

const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

export interface PublishManifest {
  version: string;
  title: string;
  description: string;
  changelog: string;
  category: string;
  /** 包内署名（SKILL.md author 字段）。 */
  author: string;
  tags: string[];
}

export interface PublishInput {
  kind: 'skill' | 'agent';
  appId: string;
  channel: 'market' | 'org';
  archive: Buffer;
  /** 发布账号（登录态），不可由请求体伪造。 */
  publisher: string;
  /** true：跳过锁定检查与待审配额，且发布即 approved（管理后台上架）。 */
  adminPublish: boolean;
  /** 待审配额，0 = 不限；仅对员工发布生效。 */
  pendingCap?: number;
  /** 非空时必须与 manifest.version 一致（管理后台表单是显式意图）。 */
  declaredVersion?: string;
  manifest: PublishManifest;
  /** 归档 sha256（调用方已算，避免重复哈希）。 */
  checksum: string;
}

export interface PublishResult {
  version: string;
  status: string;
  checksum: string;
}

interface AppRow {
  kind: string;
  app_id: string;
  title: string;
  description: string;
  owner: string;
  channel: string;
  enabled: number;
  official: number;
  deleted_at: Date | null;
  [key: string]: unknown;
}

interface ReleaseRow {
  version: string;
  checksum: string;
  publisher: string;
  [key: string]: unknown;
}

/** 版本比较（semver 数字段 + prerelease），返回 <0 / 0 / >0。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  // 无 prerelease 的版本更高。
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

function parseVersion(v: string): { nums: [number, number, number]; pre: string } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ?? '',
  };
}

class LockBusy extends Error {}

/**
 * 执行一次发布。失败一律抛 ApiError（HTTP 状态与稳定错误码由内核给出）。
 */
export async function publish(db: Database, input: PublishInput): Promise<PublishResult> {
  const { kind, appId, channel, manifest } = input;

  if (!isAppId(appId)) {
    throw new ApiError(
      CODE_INVALID_APP_ID,
      '名称不合法:必须是小写 kebab-case(如 my-skill)',
      422,
    );
  }
  if (!manifest.version || !isVersion(manifest.version)) {
    throw new ApiError(CODE_INVALID_VERSION, '版本号不合法:必须是 x.y.z', 422);
  }
  if (input.declaredVersion && input.declaredVersion !== manifest.version) {
    throw new ApiError(
      CODE_MANIFEST_MISMATCH,
      `表单版本(${input.declaredVersion})与包内 version(${manifest.version})不一致,请以包内版本为准`,
      422,
    );
  }

  // 锁定：被锁定的名字只能由管理员发布。必须在取发布锁**之前**完成。
  if (!input.adminPublish) {
    const lockRows = await db.execute<{ reason: string }>(sql`
      SELECT reason FROM capability_locks WHERE kind = ${kind} AND name = ${appId} LIMIT 1
    `);
    if (lockRows.length > 0) {
      let message = '该能力已被管理员锁定,仅管理员可发布';
      if (lockRows[0].reason) message += `:${lockRows[0].reason}`;
      throw new ApiError(CODE_APP_LOCKED, message, 403);
    }
  }

  const lockKey = `picoaide:publish:${kind}/${appId}`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      return await db.transaction(async (tx) => {
        const [lock] = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS locked`,
        );
        if (!lock?.locked) throw new LockBusy();

        const appRows = await tx.execute<AppRow>(sql`
          SELECT kind, app_id, title, description, owner, channel, enabled, official, deleted_at
          FROM apps WHERE kind = ${kind} AND app_id = ${appId} LIMIT 1
        `);
        const existing = appRows[0];
        const appExists = !!existing;

        if (existing && existing.channel !== channel) {
          throw new ApiError(
            CODE_NAME_TAKEN,
            `名称已被${channelLabel(existing.channel)}占用,请换个名字或联系管理员`,
            409,
          );
        }

        // 下架冻结：不接收新版本，也不会把待审版本置 approved（管理员直发同样受理）。
        const writable = !existing || (existing.enabled === 1 && !existing.deleted_at);
        if (!writable) {
          throw new ApiError(
            CODE_APP_DELISTED,
            `该${kindLabel(kind)}已下架，暂不能发布新版本：请先联系管理员重新上架`,
            409,
          );
        }

        // 官方内容锁定：归属官方的内容仅管理员可发布新版。
        if (existing && existing.official === 1 && !input.adminPublish) {
          throw new ApiError(CODE_OFFICIAL_LOCKED, `官方${kindLabel(kind)}仅管理员可上传`, 403);
        }

        // 归属保护：他人的 App（含空 owner 的历史行）不允许被非管理员接管发布。
        if (
          existing &&
          !input.adminPublish &&
          (existing.owner === '' || existing.owner !== input.publisher)
        ) {
          throw new ApiError(
            CODE_NAME_TAKEN,
            '名称已被占用，无法上传：请更换名称或联系管理员',
            409,
          );
        }

        const history = await tx.execute<ReleaseRow>(sql`
          SELECT version, checksum, publisher FROM app_releases
          WHERE kind = ${kind} AND app_id = ${appId} ORDER BY id
        `);
        let newest = '';
        for (const h of history) {
          if (h.version === manifest.version) {
            throw new ApiError(
              CODE_VERSION_EXISTS,
              `版本 ${manifest.version} 已存在(每个版本都是不可修改的快照),请升版本号后重试`,
              409,
            );
          }
          if (h.checksum && h.checksum === input.checksum && h.publisher === input.publisher) {
            throw new ApiError(
              CODE_CONTENT_UNCHANGED,
              `内容与你已提交的 v${h.version} 完全一致,无需重复上传`,
              409,
            );
          }
          if (newest === '' || compareVersions(h.version, newest) > 0) newest = h.version;
        }
        if (newest !== '' && compareVersions(manifest.version, newest) <= 0) {
          throw new ApiError(
            CODE_VERSION_NOT_INCREASING,
            `版本号必须大于当前最高版本 v${newest}(当前包内为 ${manifest.version})`,
            409,
          );
        }
        if (history.length > 0 && manifest.changelog.trim() === '') {
          throw new ApiError(
            CODE_MISSING_FIELD,
            '非首个版本必须填写 changelog(本版改了什么)',
            422,
          );
        }

        const pendingCap = input.pendingCap ?? 0;
        if (!input.adminPublish && pendingCap > 0) {
          const [{ count }] = await tx.execute<{ count: number }>(sql`
            SELECT COUNT(*)::int AS count FROM app_releases
            WHERE publisher = ${input.publisher} AND status = 'pending' AND deleted_at IS NULL
          `);
          if (Number(count) >= pendingCap) {
            throw new ApiError(
              CODE_PENDING_LIMIT,
              `待审核数量已达上限(${pendingCap}),请等待审核`,
              429,
            );
          }
        }

        // 归属与投影：apps 行是「目录对全员下发的投影」，待审版本不得改动投影。
        let owner = input.publisher;
        if (existing) {
          if (existing.official === 1) owner = '';
          else if (existing.owner !== '') owner = existing.owner;
        }
        const enabled = existing ? existing.enabled : 1;
        const status = input.adminPublish ? 'approved' : 'pending';

        let projTitle = manifest.title;
        let projDescription = manifest.description;
        if (status === 'pending') {
          projTitle = appId;
          projDescription = '';
          if (existing) {
            projTitle = existing.title;
            projDescription = existing.description;
            if (projTitle.trim() === '') projTitle = appId;
          }
        }

        await tx.execute(sql`
          INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled)
          VALUES (${kind}, ${appId}, ${projTitle}, ${projDescription}, ${owner}, ${channel}, ${enabled})
          ON CONFLICT (kind, app_id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            owner = CASE WHEN apps.official = 1 THEN '' ELSE COALESCE(NULLIF(apps.owner, ''), excluded.owner) END,
            updated_at = now()
        `);

        try {
          await tx.execute(sql`
            INSERT INTO app_releases
              (kind, app_id, version, title, description, changelog, category, tags, author,
               publisher, checksum, size, archive, status, reason, quality)
            VALUES
              (${kind}, ${appId}, ${manifest.version}, ${manifest.title}, ${manifest.description},
               ${manifest.changelog}, ${manifest.category}, ${JSON.stringify(manifest.tags)},
               ${manifest.author}, ${input.publisher}, ${input.checksum}, ${input.archive.length},
               ${input.archive}, ${status}, '', '')
          `);
        } catch (e) {
          // 并发窗口内唯一约束兜底（23505 → VERSION_EXISTS，而非 500）。
          if ((e as { code?: string } | null)?.code === '23505') {
            throw new ApiError(
              CODE_VERSION_EXISTS,
              `版本 ${manifest.version} 已存在(每个版本都是不可修改的快照),请升版本号后重试`,
              409,
            );
          }
          throw new ApiError('INTERNAL', '保存失败', 500);
        }

        return { version: manifest.version, status, checksum: input.checksum };
      });
    } catch (e) {
      if (e instanceof LockBusy) {
        if (Date.now() >= deadline) {
          throw new ApiError(CODE_PUBLISH_BUSY, '同名内容正在发布,排队超时,请稍后重试', 503);
        }
        await sleep(LOCK_POLL_MS);
        continue;
      }
      throw e;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function channelLabel(channel: string): string {
  switch (channel) {
    case 'market':
      return '市场';
    case 'wasm':
      return '应用（WASM）';
    default:
      return '组织共享库';
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'agent':
      return '智能体';
    case 'wasm_app':
      return '应用';
    default:
      return '技能';
  }
}
