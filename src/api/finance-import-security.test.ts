import { describe, expect, it } from "vitest";
import { ImportSecurityError, MAX_IMPORT_FILE_BYTES, assertImportFileSize, validateImportFile } from "./finance-import-security.js";

type ZipEntry = {
  name: string;
  data?: Buffer;
  flags?: number;
  method?: number;
  uncompressedSize?: number;
  externalAttr?: number;
};

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const flags = entry.flags ?? 0;
    const method = entry.method ?? 0;
    const size = entry.uncompressedSize ?? data.length;
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.set([0x50, 0x4b, 0x03, 0x04], 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.set([0x50, 0x4b, 0x01, 0x02], 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(entry.externalAttr ?? 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.set([0x50, 0x4b, 0x05, 0x06], 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function expectSecurityError(action: () => unknown, code: string) {
  try {
    action();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ImportSecurityError);
    expect((error as ImportSecurityError).code).toBe(code);
  }
}

describe("finance import file security", () => {
  it("accepts a plain CSV, a legacy XLS signature, and a minimal XLSX archive", () => {
    expect(validateImportFile("wechat.csv", Buffer.from("交易时间,金额,收支\n2026-01-01,1.00,支出\n", "utf8"))).toMatchObject({ kind: "csv", extension: "csv" });
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)]);
    expect(validateImportFile("bank.xls", ole)).toMatchObject({ kind: "xls", extension: "xls" });
    const xlsx = makeZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
    ]);
    expect(validateImportFile("bank.xlsx", xlsx)).toMatchObject({ kind: "xlsx", extension: "xlsx" });
  });

  it("rejects unsupported extensions and path-like file names before upload", () => {
    expect(() => validateImportFile("bank.pdf", Buffer.from("pdf"))).toThrow(ImportSecurityError);
    expectSecurityError(() => validateImportFile("../bank.csv", Buffer.from("a,b\n")), "IMPORT_FILE_NAME_INVALID");
    expectSecurityError(() => validateImportFile("bank\\wechat.csv", Buffer.from("a,b\n")), "IMPORT_FILE_NAME_INVALID");
  });

  it("rejects empty or oversized files", () => {
    expectSecurityError(() => assertImportFileSize(0), "IMPORT_FILE_EMPTY");
    expectSecurityError(() => assertImportFileSize(MAX_IMPORT_FILE_BYTES + 1), "IMPORT_FILE_TOO_LARGE");
  });

  it("rejects files whose bytes contradict the extension", () => {
    expectSecurityError(() => validateImportFile("bank.csv", Buffer.from("PK\x03\x04not-a-csv")), "IMPORT_FILE_CONTENT_INVALID");
    expectSecurityError(() => validateImportFile("bank.xls", Buffer.from("not-an-ole")), "IMPORT_FILE_CONTENT_INVALID");
    expectSecurityError(() => validateImportFile("bank.xlsx", Buffer.from("not-a-zip")), "IMPORT_FILE_CONTENT_INVALID");
    expectSecurityError(() => validateImportFile("bank.csv", Buffer.from("a,b\u0000\n")), "IMPORT_FILE_CONTENT_INVALID");
  });

  it("rejects XLSX macros, external links, encrypted entries, symlinks and traversal", () => {
    const required = [{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") }];
    expectSecurityError(() => validateImportFile("macro.xlsx", makeZip([...required, { name: "xl/vbaProject.bin", data: Buffer.from("macro") }])), "IMPORT_ZIP_UNSAFE");
    expectSecurityError(() => validateImportFile("external.xlsx", makeZip([...required, { name: "xl/externalLinks/externalLink1.xml", data: Buffer.from("<external/>") }])), "IMPORT_ZIP_UNSAFE");
    expectSecurityError(() => validateImportFile("encrypted.xlsx", makeZip([...required, { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>"), flags: 0x1 }])), "IMPORT_ZIP_UNSAFE");
    expectSecurityError(() => validateImportFile("symlink.xlsx", makeZip([...required, { name: "xl/links/sheet1.xml", data: Buffer.from("link"), externalAttr: 0xa1ff0000 }])), "IMPORT_ZIP_UNSAFE");
    expectSecurityError(() => validateImportFile("traversal.xlsx", makeZip([...required, { name: "../evil.xml", data: Buffer.from("evil") }])), "IMPORT_ZIP_UNSAFE");
  });

  it("rejects oversized uncompressed ZIP output", () => {
    const entries = [
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>"), uncompressedSize: 32 * 1024 * 1024 + 1 },
    ];
    expectSecurityError(() => validateImportFile("bomb.xlsx", makeZip(entries)), "IMPORT_ZIP_UNSAFE");
  });
});
