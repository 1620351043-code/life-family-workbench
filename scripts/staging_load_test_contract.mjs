import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const loadScript = await readFile(new URL("./staging_load_test.mjs", import.meta.url), "utf8");

await execFileAsync("node", ["--check", new URL("./staging_load_test.mjs", import.meta.url).pathname]);
assert.match(loadScript, /I_UNDERSTAND_THIS_RUNS_LOAD_TEST/);
assert.match(loadScript, /base\.protocol !== "https:"/);
assert.match(loadScript, /127\.0\.0\.1/);
assert.match(loadScript, /LIFE_LOAD_ALLOW_PRODUCTION/);
assert.match(loadScript, /LIFE_LOAD_CONCURRENCY/);
assert.match(loadScript, /integer\("LIFE_LOAD_CONCURRENCY", 8, 1, 128\)/);
assert.match(loadScript, /LIFE_LOAD_MAX_P95_MS/);
assert.match(loadScript, /AbortSignal\.timeout/);
assert.match(loadScript, /console\.log\(JSON\.stringify\(report/);
assert.doesNotMatch(loadScript, /console\.log.*(password|token|secret)/i);

console.log(JSON.stringify({ ok: true, checks: 10, contract: "I-014 staging load test" }));
