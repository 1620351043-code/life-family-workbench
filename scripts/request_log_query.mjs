#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const traceId = process.argv[2]?.trim();
if (!traceId) {
  console.error("usage: node scripts/request_log_query.mjs <trace-id>");
  process.exit(2);
}
const service = process.env.LIFE_LOG_SERVICE?.trim() || "life-staging.service";
const since = process.env.LIFE_LOG_SINCE?.trim() || "5 minutes ago";

const allowed = (entry) => ({
  time: entry.time ?? null,
  trace_id: entry.trace_id ?? null,
  req_id: entry.reqId ?? null,
  method: entry.method ?? null,
  route: entry.route ?? null,
  status_code: entry.status_code ?? null,
  duration_ms: entry.duration_ms ?? null,
  error_code: entry.error_code ?? null,
  msg: entry.msg ?? null,
});

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
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.trace_id === traceId || entry.reqId === traceId)
    .map(allowed);
  console.log(JSON.stringify({ ok: true, service, trace_id: traceId, entries }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, service, trace_id: traceId, error: message }));
  process.exit(1);
}
