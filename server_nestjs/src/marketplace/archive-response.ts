import type { Response } from 'express';
import type { ArchivePayload } from './marketplace.service';

/**
 * 写归档字节流响应：Content-Type / Content-Disposition + 版本与校验和头。
 * 头名按契约：技能 X-Skill-Version / X-Skill-Checksum，
 * 智能体 X-Preset-Version / X-Preset-Checksum（与 Go serveSkillArchive 一致）。
 */
export function sendArchive(
  res: Response,
  payload: ArchivePayload,
  headerPrefix: 'X-Skill' | 'X-Preset',
): void {
  res.setHeader('Content-Type', payload.contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${payload.filename}"`,
  );
  res.setHeader(`${headerPrefix}-Version`, payload.version);
  res.setHeader(`${headerPrefix}-Checksum`, payload.checksum);
  res.setHeader('Content-Length', String(payload.archive.length));
  res.end(payload.archive);
}
