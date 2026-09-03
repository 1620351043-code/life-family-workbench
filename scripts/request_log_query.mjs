#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export function parseJournalLine(line) {
  const raw = JSON.parse(line.trim());
  const rawMessage = typeof raw.MESSAGE === "string" ? raw.MESSAGE : "";
  if (!rawMessage.startsWith("{")) return raw;
  try {
    return { ...raw, ...JSON.parse(rawMessage) };
  } catch {
    return raw;
  }
}

export function allowedLogEntry(entry) {
  return {
    time: entry.time ?? null,
    trace_id: entry.trace_id ?? null,
    req_id: entry.reqId ?? null,
    method: entry.method ?? null,
    route: entry.route ?? null,
    status_code: entry.status_code ?? null,
    duration_ms: entry.duration_ms ?? null,
    error_code: entry.error_code ?? null,
    msg: entry.msg ?? null,
  };
}

async function main() {
  const traceId = process.argv[2]?.trim();
  if (!traceId) {
    console.error("usage: node scripts/request_log_query.mjs <trace-id>");
    process.exit(2);
  }
  const service = process.env.LIFE_LOG_SERVICE?.trim() || "life-staging.service";
  const since = process.env.LIFE_LOG_SINCE?.trim() || "5 minutes ago";

  try {
    const { stdout } = await execFileAsync(
      "journalctl",
      ["-u", service, "--no-pager", "-o", "json", `--since=${since}`],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const entries = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseJournalLine)
      .filter((entry) => entry.trace_id === traceId || entry.reqId === traceId)
      .map(allowedLogEntry);
    console.log(JSON.stringify({ ok: true, service, trace_id: traceId, entries }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, service, trace_id: traceId, error: message }));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
