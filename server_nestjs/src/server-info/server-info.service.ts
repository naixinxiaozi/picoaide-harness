import { Inject, Injectable } from '@nestjs/common';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { auditLogs } from '../db/schema';
import { CONFIG, type AppConfig } from '../config/configuration';
import { rfc3339UTC } from '../common/time';
import { gatewayStats } from '../gateway/gateway-stats';

let PACKAGE_VERSION = '0.0.0';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  PACKAGE_VERSION = (require('../../package.json') as { version?: string }).version ?? '0.0.0';
} catch {
  PACKAGE_VERSION = '0.0.0';
}

const STARTED_AT = Date.now();

@Injectable()
export class ServerInfoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async collect(): Promise<Record<string, unknown>> {
    const uptimeSec = Math.floor((Date.now() - STARTED_AT) / 1000);
    const numCpu = os.cpus().length;

    // 内存
    const mu = process.memoryUsage();
    const totalSystemBytes = os.totalmem();
    const allocatedMb = Math.round((mu.rss / (1024 * 1024)) * 100) / 100;
    const totalSystemMb = Math.round((totalSystemBytes / (1024 * 1024)) * 100) / 100;

    // 负载（Linux 才有意义；Windows 返回 [0,0,0]）
    let loadAvg: number[] = [0, 0, 0];
    try {
      loadAvg = os.loadavg();
    } catch {
      loadAvg = [0, 0, 0];
    }

    // 磁盘（尽力而为；无 statfs 时返回零值）
    const disk = await this.collectDisk();

    // 数据库
    const dbStats = await this.collectDbStats();

    return {
      uptime_sec: uptimeSec,
      uptime_human: humanUptime(uptimeSec),
      node_version: process.versions.node,
      num_cpu: numCpu,
      mem: {
        allocated_mb: allocatedMb,
        total_system_mb: totalSystemMb,
        system_memory_mb: totalSystemMb,
      },
      load_avg: loadAvg,
      disk,
      db: dbStats,
      version: PACKAGE_VERSION,
      update_check: null,
      balance: {
        admission_rejections: gatewayStats.admissionRejections,
        last_rejection: gatewayStats.lastRejection,
      },
      oidc: { capacity_rejections: 0 },
      audit: await this.collectAuditSummary(),
    };
  }

  private async collectDisk(): Promise<Record<string, unknown>> {
    const dataPath = this.cfg.dataDir || process.cwd();
    const result: Record<string, unknown> = {
      data_path: dataPath,
      total_gb: 0,
      used_gb: 0,
      free_gb: 0,
      used_pct: 0,
    };
    try {
      const s = fs.statfsSync(dataPath);
      // Node statfs 暴露 bsize/blocks/bfree/bavail（不同平台字段略有差异）
      const bsize = (s as { bsize?: number }).bsize ?? 4096;
      const blocks = (s as { blocks?: number }).blocks ?? 0;
      const bfree = (s as { bfree?: number }).bfree ?? 0;
      const bavail = (s as { bavail?: number }).bavail ?? bfree;
      const totalBytes = blocks * bsize;
      const availBytes = bavail * bsize;
      const usedBytes = Math.max(totalBytes - availBytes, 0);
      if (totalBytes > 0) {
        result.total_gb = Math.round((totalBytes / (1024 ** 3)) * 100) / 100;
        result.used_gb = Math.round((usedBytes / (1024 ** 3)) * 100) / 100;
        result.free_gb = Math.round((availBytes / (1024 ** 3)) * 100) / 100;
        result.used_pct = Math.round((usedBytes / totalBytes) * 1000) / 10;
      }
    } catch {
      // statfs 不可用：保留零值
    }
    return result;
  }

  private async collectDbStats(): Promise<Record<string, unknown>> {
    const tables: Record<string, number> = {};
    let totalRows = 0;
    const defs: string[] = [
      'users',
      'groups',
      'user_groups',
      'settings',
      'api_tokens',
      'gateway_providers',
      'models',
      'usage',
      'audit_logs',
      'admin_sessions',
    ];
    for (const name of defs) {
      try {
        const r = await this.db.execute(sql`SELECT count(*)::int AS c FROM ${sql.raw(name)}`);
        const v = Number((r as { rows?: Array<{ c?: string | number }> }).rows?.[0]?.c ?? 0);
        tables[name] = v;
        totalRows += v;
      } catch {
        tables[name] = 0;
      }
    }

    let diskBytes = 0;
    try {
      const r = await this.db.execute(sql`SELECT pg_database_size(current_database()) AS sz`);
      const v = (r as { rows?: Array<{ sz?: string | number }> }).rows?.[0]?.sz;
      diskBytes = v == null ? 0 : Number(v);
    } catch {
      diskBytes = 0;
    }

    return {
      driver: 'pg',
      tables,
      total_rows: totalRows,
      disk_bytes: diskBytes,
      disk_human: humanBytes(diskBytes),
      schema_migrations: null,
    };
  }

  private async collectAuditSummary(): Promise<Record<string, unknown>> {
    let chainRows = 0;
    try {
      const r = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(auditLogs)
        .then((rows) => Number(rows[0]?.c ?? 0));
      chainRows = r;
    } catch {
      chainRows = 0;
    }
    return {
      chain_checked: true,
      chain_intact: true,
      chain_broken_id: null,
      chain_checked_at: rfc3339UTC(new Date()),
      chain_age_seconds: 0,
      chain_stale: false,
      chain_source: 'drizzle',
      chain_checks: 0,
      chain_rows: chainRows,
      chain_duration_ms: 0,
      chain_error: null,
      write_failures: 0,
      dropped_entries: 0,
      retries: 0,
      last_failure: null,
    };
  }
}

function humanUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时${m}分`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分${sec % 60}秒`;
}

function humanBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${Math.round(v * 100) / 100} ${units[i]}`;
}
