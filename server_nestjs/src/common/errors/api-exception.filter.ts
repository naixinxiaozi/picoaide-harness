import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from './api-error';

/**
 * 全局异常过滤器：把一切异常收敛为 {"error":{"code","message"}} 信封。
 * - ApiError → 契约 code + 映射状态
 * - HttpException（含 ValidationPipe 400）→ VALIDATION
 * - 其余 → INTERNAL（详情只进日志，不外泄）
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof ApiError) {
      res.status(exception.status).json(exception.toBody());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // class-validator 校验失败（BadRequestException 400）→ VALIDATION。
      const code = status === HttpStatus.BAD_REQUEST ? 'VALIDATION' : 'INTERNAL';
      const body = exception.getResponse();
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? extractMessage((body as { message: unknown }).message)
          : exception.message;
      res.status(status).json({ error: { code, message } });
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: 'internal error' },
    });
  }
}

function extractMessage(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return msg
      .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
      .join('; ');
  }
  return String(msg);
}
