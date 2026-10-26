import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, raw, urlencoded } from 'express';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import { loadConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // LLM 代理路径的原始请求体捕获（最高 64 MiB）：在全局 json() 之前挂载，
  // 网关需原样转发上游请求体（含 SSE/流式所需的完整 body），不能用 1MB 的 JSON 解析。
  app.use(
    [
      '/v1',
      '/chat/completions',
      '/completions',
      '/responses',
      '/messages',
      '/embeddings',
      '/models',
      '/files',
    ],
    raw({ type: () => true, limit: '64mb' }),
  );

  // 请求体大小限制（与现有 1MB 默认对齐；大文件路由在控制器内单独放宽）。
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      // 与 Go 侧一致：请求体校验在服务层手动完成（精确文案），全局管道不做
      // 白名单裁剪，只做基础 transform。避免 class-validator 先行拦截破坏契约文案。
      whitelist: false,
      transform: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());

  // 管理端 web（Nuxt 独立工程）以凭据方式直连本服务，需 CORS + 凭据。
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });

  app.enableShutdownHooks();

  const cfg = loadConfig();
  const { host, port } = parseAddr(cfg.addr);
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`picoaide-server-nestjs listening on ${host}:${port}`);
}

function parseAddr(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(':');
  if (idx === -1) return { host: '0.0.0.0', port: Number(addr) };
  const host = addr.slice(0, idx) || '0.0.0.0';
  const port = Number(addr.slice(idx + 1));
  return { host, port };
}

void bootstrap();
