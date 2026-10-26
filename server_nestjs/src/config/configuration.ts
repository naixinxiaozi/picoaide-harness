/**
 * 环境配置中心：从进程环境读取并导出强类型配置。
 * 缺省值仅供本地开发；生产值进部署机 .env（不进版本库）。
 *
 * 注意：`./env` 的 import 有副作用（装载 .env 文件），必须排在最前，
 * 否则下面的 loadConfig() 读不到文件里的值。
 */
import { env } from './env';

export interface AppConfig {
  /** 监听地址，如 0.0.0.0:8787。 */
  addr: string;
  /** 服务端数据目录（归档/技能/安装包落盘）。 */
  dataDir: string;
  /** PostgreSQL DSN。 */
  pgDsn: string;
  /** bootstrap 引导管理员用户名（首次启动创建）。 */
  bootstrapAdmin: string;
  /** bootstrap 管理员初始密码。 */
  adminPassword: string;
  /** master key 文件路径（AES-GCM 密钥，缺省按 ENV 回退）。 */
  masterKeyFile: string;
  /** master key 明文（优先于文件；生产建议用文件）。 */
  masterKey: string;
  /** 是否允许注册（员工自助注册开关）。 */
  allowSignup: boolean;
}

export function loadConfig(): AppConfig {
  return {
    addr: env('ADDR', '0.0.0.0:8787'),
    dataDir: env('DATA_DIR', './data'),
    pgDsn: env('PG_DSN', 'postgres://picoaide:change-me@127.0.0.1:5432/picoaide'),
    bootstrapAdmin: env('BOOTSTRAP_ADMIN', ''),
    adminPassword: env('PICOAI_ADMIN_PASSWORD', ''),
    masterKeyFile: env('MASTER_KEY_FILE', ''),
    masterKey: env('MASTER_KEY', ''),
    allowSignup: env('ALLOW_SIGNUP') === 'true',
  };
}

export const CONFIG = 'CONFIG';
