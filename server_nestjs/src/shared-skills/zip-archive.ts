/**
 * 极简 ZIP 读取器（只读、无第三方依赖）。
 *
 * 共享技能 / 智能体预置的 POST /upload 接收的是 zip（或历史遗留的 tar.gz）归档，
 * 管理端的 preview / file 需要在不落盘的前提下列出条目并读出单个文件内容。
 * 这里只实现「中央目录解析 + 单条目解压」，支持 store(0) 与 deflate(8) 两种方法：
 *  - 不处理 zip64（条目数 / 大小上限 0xffffffff，超限一律视为非 zip → 空清单）；
 *  - 不做路径穿越校验（只做只读内容展示，不解压到磁盘）。
 *
 * 备注：这个模块放在 shared-skills/ 是因为两个域都需要它；等 src/common 允许新增
 * 归档工具时再迁过去（当前任务约束不允许改 common/）。
 */

import { isUtf8 } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

export interface ArchiveEntry {
  path: string;
  /** 未压缩大小（来自中央目录，可能是伪造值；仅用于展示与上限判断）。 */
  size: number;
}

export interface ArchiveEntryContent {
  size: number;
  binary: boolean;
  too_large: boolean;
  content: string;
}

/** zip 魔数：PK\x03\x04。 */
export function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;
}

/** gzip 魔数：0x1f 0x8b。 */
export function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

interface RawEntry extends ArchiveEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readEntries(buffer: Buffer): RawEntry[] {
  if (buffer.length < EOCD_MIN_BYTES) return [];
  const lowest = Math.max(0, buffer.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  let eocd = -1;
  for (let i = buffer.length - EOCD_MIN_BYTES; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  // zip64：条目数或偏移溢出 16/32 位 → 不支持，按空清单处理。
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return [];
  if (centralOffset + centralSize > buffer.length) return [];

  const out: RawEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > buffer.length) break;
    const path = buffer.toString('utf8', nameStart, nameStart + nameLength);
    // 目录条目（以 / 结尾）不进入文件清单。
    if (!path.endsWith('/')) out.push({ path, size, method, compressedSize, localOffset });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return out;
}

/** 列出归档内的文件条目；非 zip / 损坏归档返回空数组。 */
export function listArchiveEntries(buffer: Buffer): ArchiveEntry[] {
  return readEntries(buffer).map((entry) => ({ path: entry.path, size: entry.size }));
}

/**
 * 读取单个条目。
 *
 * 大小上限由调用方决定（技能预览 128KB / 智能体文件 1MB）；超过上限不返回正文，
 * 只回报 too_large，避免把压缩炸弹展开到内存。
 */
export function readArchiveEntry(
  buffer: Buffer,
  path: string,
  maxBytes: number,
): ArchiveEntryContent | null {
  const entry = readEntries(buffer).find((item) => item.path === path);
  if (!entry) return null;
  if (entry.size > maxBytes) {
    return { size: entry.size, binary: false, too_large: true, content: '' };
  }
  const headerStart = entry.localOffset;
  if (headerStart + 30 > buffer.length) return null;
  if (buffer.readUInt32LE(headerStart) !== LOCAL_SIGNATURE) return null;
  const nameLength = buffer.readUInt16LE(headerStart + 26);
  const extraLength = buffer.readUInt16LE(headerStart + 28);
  const dataStart = headerStart + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) return null;
  const raw = buffer.subarray(dataStart, dataEnd);
  let data: Buffer;
  if (entry.method === 0) {
    data = raw;
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: maxBytes + 1 });
    } catch {
      return { size: entry.size, binary: false, too_large: true, content: '' };
    }
  } else {
    // 其它压缩方法（bzip2/lzma 等）不在支持范围。
    return null;
  }
  const binary = !isUtf8(data) || data.includes(0);
  return {
    size: data.length,
    binary,
    too_large: data.length > maxBytes,
    content: binary || data.length > maxBytes ? '' : data.toString('utf8'),
  };
}

/** 取归档内指定路径的文本内容（用于 SKILL.md / preset.yml 预览），找不到返回空串。 */
export function readArchiveText(buffer: Buffer, path: string, maxBytes: number): string {
  const found = readArchiveEntry(buffer, path, maxBytes);
  if (!found || found.too_large || found.binary) return '';
  return found.content;
}
