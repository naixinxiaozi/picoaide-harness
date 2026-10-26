/**
 * 归档（zip / tar.gz）二进制响应助手。
 *
 * 共享技能与智能体预置的归档下载共用同一套响应口径（与 Go 端 serveArchive 对齐）：
 * Content-Type 按魔数判 zip / gzip，Content-Disposition 带 name-version 文件名，
 * 另加版本与校验头（技能 X-Skill-*，智能体 X-Preset-*）。
 *
 * 放在 shared-skills/ 而不是 common/：本任务只允许改这两个域；两个域的 controller
 * 都从这里 import（跨域 import 已在报告中登记为遗留风险）。
 */

import type { Response } from 'express';

export interface ArchivePayloadLike {
  payload: Buffer;
  filename: string;
  contentType: string;
  version: string;
  checksum: string;
}

/** 响应头里的文件名只保留安全字符（防 header 注入 / 引号破坏）。 */
function safeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned === '' ? 'archive' : cleaned;
}

export function writeArchiveResponse(
  res: Response,
  archive: ArchivePayloadLike,
  versionHeader: string,
  checksumHeader: string,
): void {
  res.setHeader('Content-Type', archive.contentType);
  res.setHeader('Content-Length', String(archive.payload.length));
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(archive.filename)}"`);
  res.setHeader(versionHeader, archive.version);
  res.setHeader(checksumHeader, archive.checksum);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(archive.payload);
}
