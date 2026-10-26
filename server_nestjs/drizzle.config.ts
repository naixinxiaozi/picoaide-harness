import { defineConfig } from 'drizzle-kit';

// 真实连接串只放部署机 .env（本文件进版本库，禁止写入真实凭据）。
// drizzle-kit 会自动读取 cwd 下的 .env / .env.local。
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.PG_DSN ??
      'postgres://picoaide:change-me@127.0.0.1:5432/picoaide',
  },
  strict: true,
  verbose: true,
});
