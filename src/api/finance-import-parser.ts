import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ImportObjectStore } from "./import-storage.js";

const execFileAsync = promisify(execFile);

export type ParsedImportRecord = {
  source_row_number: number;
  occurred_at: string;
  direction: "income" | "expense" | "transfer";
  amount: string;
  currency: string;
  merchant: string;
  external_id: string;
  channel: string;
  remark: string;
  source_fingerprint: string;
  sheet_name: string | null;
};

export type ParsedImportPreviewRow = {
  row_number: number;
  values: string[];
  role: "blank" | "metadata" | "header" | "data";
};

export type ParsedImportSheet = {
  sheet_name: string | null;
  header_row: number | null;
  data_start_row: number | null;
  header_score: number;
  field_mapping: Record<string, string>;
  preview_rows: ParsedImportPreviewRow[];
  records: ParsedImportRecord[];
  skipped_rows: number;
  empty?: boolean;
};

export type ParsedImportResult = {
  schema_version: "life.finance.import.v1";
  parser_version: string;
  source_type: string;
  file_name: string;
  detected_sheet: string | null;
  detected_header_row: number | null;
  sheets: ParsedImportSheet[];
  records: ParsedImportRecord[];
  counts: { sheets: number; rows: number; skipped_rows: number };
};

export type FinanceImportParseInput = { objectKey: string; sourceType: string; fileName: string };

export interface FinanceImportParser {
  parse(input: FinanceImportParseInput): Promise<ParsedImportResult>;
}

function bundledPythonCandidates() {
  return [
    process.env.LIFE_FINANCE_PARSER_PYTHON,
    "/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
    "python3",
  ].filter((item): item is string => Boolean(item));
}

async function firstAvailablePython() {
  for (const candidate of bundledPythonCandidates()) {
    if (candidate.includes("/")) {
      try {
        await access(candidate);
        return candidate;
      } catch (_) {
        continue;
      }
    }
    return candidate;
  }
  throw new Error("未找到财务账单解析 Python 运行时");
}

function parseWorkerScript() {
  return join(dirname(new URL(import.meta.url).pathname), "../../workers/finance_import_worker.py");
}

export class LocalFinanceImportParser implements FinanceImportParser {
  constructor(private readonly objectStore: ImportObjectStore) {}

  async parse(input: FinanceImportParseInput) {
    const bytes = await this.objectStore.read(input.objectKey);
    const workDir = await mkdtemp(join(tmpdir(), "life-finance-parse-"));
    const filePath = join(workDir, input.fileName.replaceAll("/", "_").replaceAll("\\", "_"));
    await writeFile(filePath, bytes, { mode: 0o600 });
    try {
      const python = await firstAvailablePython();
      const { stdout, stderr } = await execFileAsync(python, [parseWorkerScript(), "--file", filePath, "--source-type", input.sourceType], {
        cwd: dirname(parseWorkerScript()),
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      if (!stdout.trim()) throw new Error(stderr.trim() || "解析 worker 没有返回结果");
      const result = JSON.parse(stdout) as ParsedImportResult;
      if (result.schema_version !== "life.finance.import.v1" || !Array.isArray(result.records)) throw new Error("解析 worker 返回格式不受支持");
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`账单解析失败：${detail}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
