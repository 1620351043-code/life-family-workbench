import { extname } from "node:path";

export const IMPORT_FILE_EXTENSIONS = ["csv", "xls", "xlsx"] as const;
export type ImportFileKind = (typeof IMPORT_FILE_EXTENSIONS)[number];

export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILE_NAME_BYTES = 255;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_NAME_BYTES = 1_024;
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_CENTRAL_MAGIC = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const ZIP_END_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export class ImportSecurityError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ImportSecurityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function importFileExtension(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  const extension = extname(normalized).slice(1);
  if (!extension) throw new ImportSecurityError("IMPORT_FILE_NAME_INVALID", "账单文件名缺少支持的扩展名", 400);
  return extension;
}

export function assertImportFileName(fileName: string): string {
  const value = fileName.trim();
  if (!value) throw new ImportSecurityError("IMPORT_FILE_NAME_INVALID", "账单文件名不能为空", 400);
  if (value.length > MAX_IMPORT_FILE_NAME_BYTES) throw new ImportSecurityError("IMPORT_FILE_NAME_INVALID", "账单文件名不能超过 255 个字符", 400);
  if (/[\\/\u0000-\u001f\u007f]/u.test(value)) throw new ImportSecurityError("IMPORT_FILE_NAME_INVALID", "账单文件名不能包含路径、反斜杠或控制字符", 400);
  if (value === "." || value === "..") throw new ImportSecurityError("IMPORT_FILE_NAME_INVALID", "账单文件名无效", 400);
  const extension = importFileExtension(value);
  if (!(IMPORT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new ImportSecurityError("IMPORT_FILE_TYPE_UNSUPPORTED", "首发版本仅支持 CSV、XLS、XLSX 账单文件", 415);
  }
  return value;
}

export function assertImportFileSize(size: number): void {
  if (!Number.isFinite(size) || !Number.isInteger(size) || size < 1) {
    throw new ImportSecurityError("IMPORT_FILE_EMPTY", "账单文件不能为空", 400);
  }
  if (size > MAX_IMPORT_FILE_BYTES) {
    throw new ImportSecurityError("IMPORT_FILE_TOO_LARGE", "账单文件不能超过 50MB", 413);
  }
}

function startsWithMagic(bytes: Buffer, magic: Buffer): boolean {
  return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}

function hasUtf16Bom(bytes: Buffer): boolean {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

function assertCsvLooksLikeText(bytes: Buffer): void {
  if (bytes.includes(0) && !hasUtf16Bom(bytes)) {
    throw new ImportSecurityError("IMPORT_FILE_CONTENT_INVALID", "CSV 文件包含二进制 NUL 字节，内容与扩展名不符", 400);
  }
}

type ZipEndRecord = {
  entryCount: number;
  directoryOffset: number;
  directorySize: number;
  directoryEnd: number;
};

function readU16(bytes: Buffer, offset: number): number {
  return bytes.readUInt16LE(offset);
}

function readU32(bytes: Buffer, offset: number): number {
  return bytes.readUInt32LE(offset);
}

function findZipEndRecord(bytes: Buffer): ZipEndRecord {
  const minOffset = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (bytes[offset] !== ZIP_END_MAGIC[0] || bytes[offset + 1] !== ZIP_END_MAGIC[1] || bytes[offset + 2] !== ZIP_END_MAGIC[2] || bytes[offset + 3] !== ZIP_END_MAGIC[3]) continue;
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength > bytes.length) continue;
    const entryCount = readU16(bytes, offset + 10);
    const directorySize = readU32(bytes, offset + 12);
    const directoryOffset = readU32(bytes, offset + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "暂不支持 ZIP64 格式的账单压缩结构", 400);
    }
    if (directorySize > bytes.length || directoryOffset + directorySize > offset) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩目录结构非法", 400);
    }
    return { entryCount, directoryOffset, directorySize, directoryEnd: directoryOffset + directorySize };
  }
  throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单文件不是有效的 XLSX 压缩结构", 400);
}

function assertSafeZipName(name: string): void {
  if (!name || name.includes("\u0000") || name.length > MAX_ZIP_NAME_BYTES || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || name.includes("\\")) {
    throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包包含非法路径", 400);
  }
  if (name.split("/").some((part) => part === "." || part === "..")) {
    throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包包含路径穿越", 400);
  }
  const lower = name.toLowerCase();
  if (lower.startsWith("__macosx/") || /(^|\/)vbaproject\.bin$/i.test(lower) || /(^|\/)externalblink/i.test(lower) || /(^|\/)externallink/i.test(lower) || /\.(xlsm|xltm|xlam)$/i.test(lower)) {
    throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包包含宏、外部链接或非法内容", 400);
  }
}

function assertZipArchive(bytes: Buffer): Set<string> {
  if (!startsWithMagic(bytes, ZIP_LOCAL_MAGIC)) {
    throw new ImportSecurityError("IMPORT_FILE_CONTENT_INVALID", "XLSX 文件内容不是 ZIP 结构，内容与扩展名不符", 400);
  }
  const end = findZipEndRecord(bytes);
  if (end.entryCount < 1 || end.entryCount > MAX_ZIP_ENTRIES) {
    throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包条目数量超出安全范围", 400);
  }
  const names = new Set<string>();
  let cursor = end.directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < end.entryCount; index += 1) {
    if (cursor + 46 > end.directoryEnd || bytes[cursor] !== ZIP_CENTRAL_MAGIC[0] || bytes[cursor + 1] !== ZIP_CENTRAL_MAGIC[1] || bytes[cursor + 2] !== ZIP_CENTRAL_MAGIC[2] || bytes[cursor + 3] !== ZIP_CENTRAL_MAGIC[3]) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩目录条目非法", 400);
    }
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const externalAttributes = readU32(bytes, cursor + 38);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > end.directoryEnd || nameLength < 1 || nameLength > MAX_ZIP_NAME_BYTES) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包文件名非法", 400);
    }
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包包含加密或非常规压缩内容", 400);
    }
    const mode = (externalAttributes >>> 16) & 0xffff;
    if ((mode & 0xf000) === 0xa000) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包不能包含符号链接", 400);
    }
    const name = bytes.subarray(nameStart, nameEnd).toString("utf8");
    assertSafeZipName(name);
    if (names.has(name)) throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包包含重复路径", 400);
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包单个条目解压后过大", 400);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩包解压后总大小超过安全限制", 400);
    }
    names.add(name);
    cursor = nameEnd + extraLength + commentLength;
    if (cursor > end.directoryEnd) throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单压缩目录长度非法", 400);
  }
  if (!names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) {
    throw new ImportSecurityError("IMPORT_FILE_CONTENT_INVALID", "XLSX 文件缺少标准工作簿结构", 400);
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".rels") || lower.endsWith("workbook.xml")) {
      // Names already reject externalLinks; add one cheap guard for
      // relationship files that smuggle an absolute local path.
      if (lower.includes("external")) throw new ImportSecurityError("IMPORT_ZIP_UNSAFE", "账单工作簿包含外部引用", 400);
    }
  }
  return names;
}

export function validateImportFile(fileName: string, bytes: Buffer): { kind: ImportFileKind; extension: string; size: number } {
  assertImportFileName(fileName);
  assertImportFileSize(bytes.byteLength);
  const extension = importFileExtension(fileName);
  if (extension === "csv") {
    if (startsWithMagic(bytes, ZIP_LOCAL_MAGIC) || startsWithMagic(bytes, OLE_MAGIC)) {
      throw new ImportSecurityError("IMPORT_FILE_CONTENT_INVALID", "CSV 文件内容与其扩展名不符", 400);
    }
    assertCsvLooksLikeText(bytes);
    return { kind: "csv", extension, size: bytes.byteLength };
  }
  if (extension === "xlsx") {
    assertZipArchive(bytes);
    return { kind: "xlsx", extension, size: bytes.byteLength };
  }
  if (extension === "xls") {
    if (!startsWithMagic(bytes, OLE_MAGIC)) {
      throw new ImportSecurityError("IMPORT_FILE_CONTENT_INVALID", "XLS 文件不是有效的旧版 Excel 文档", 400);
    }
    return { kind: "xls", extension, size: bytes.byteLength };
  }
  throw new ImportSecurityError("IMPORT_FILE_TYPE_UNSUPPORTED", "首发版本仅支持 CSV、XLS、XLSX 账单文件", 415);
}
