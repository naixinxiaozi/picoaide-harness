import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 极简 `.env` 装载器（零依赖）。
 *
 * 为什么自己写而不是引入 dotenv：本项目要求「不新增运行时依赖」，而 `.env`
 * 只是 KEY=VALUE 行；`process.env` 里已存在的变量一律不覆盖（便于容器/CI 注入
 * 覆盖文件值）。支持 `#` 注释、行首行尾空白、成对引号。
 *
 * 副作用在模块首次被 import 时立即执行，保证后续任何 provider 工厂
 * （如 DatabaseModule 的 postgres 连接池）都能读到文件里的值。
 */
function loadEnvFiles(files: readonly string[]): void {
  for (const file of files) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!key || process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnvFiles(['.env.local', '.env']);

/** 读取环境变量；空字符串视为未设置。 */
export function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}
