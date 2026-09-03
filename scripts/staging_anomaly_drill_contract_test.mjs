import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("./staging_anomaly_drill.mjs", import.meta.url);
const source = await readFile(scriptUrl, "utf8");

await execFileAsync("node", ["--check", scriptUrl.pathname]);

assert.match(source, /I_UNDERSTAND_THIS_RUNS_ANOMALY_DRILL/);
assert.match(source, /LIFE_ANOMALY_BASE_URL/);
assert.match(source, /LIFE_ANOMALY_DB_URL/);
assert.match(source, /AbortSignal\.timeout/);
assert.match(source, /isolation/);
assert.match(source, /large_import/);
assert.match(source, /queue/);
assert.match(source, /ai/);
assert.match(source, /slow/);
assert.match(source, /EXPLAIN \(ANALYZE, BUFFERS/);
assert.match(source, /runDirectExportWorker/);
assert.match(source, /assertNoCredentialOutput/);
assert.match(source, /writeFile\(filePath/);
assert.doesNotMatch(source, /console\.log.*(password|token|secret)/i);

console.log(JSON.stringify({ ok: true, checks: 12, contract: "I-014 anomaly drill" }));
