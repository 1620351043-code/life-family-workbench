import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const drillScript = await readFile(new URL("./release_rollback_drill.sh", import.meta.url), "utf8");

await execFileAsync("bash", ["-n", new URL("./release_rollback_drill.sh", import.meta.url).pathname]);
assert.match(drillScript, /I_UNDERSTAND_THIS_PREPARES_RELEASE_ROLLBACK_DRILL/);
assert.match(drillScript, /LIFE_RELEASE_DRY_RUN/);
assert.match(drillScript, /当前只能为 YES/);
assert.match(drillScript, /refs\/tags/);
assert.match(drillScript, /merge-base --is-ancestor/);
assert.match(drillScript, /worktree\/\$current_tag/);
assert.match(drillScript, /worktree\/\$previous_tag/);
assert.match(drillScript, /life_schema_migration/);
assert.match(drillScript, /plan_path/);
assert.match(drillScript, /chmod 0600 "\$plan_path"/);
assert.doesNotMatch(drillScript, /rm -rf|rm -f/);
assert.doesNotMatch(drillScript, /echo \$database_url/);
assert.doesNotMatch(drillScript, /echo \$LIFE_RELEASE_DATABASE_URL/);

console.log(JSON.stringify({ ok: true, checks: 13, contract: "I-015 release rollback dry-run plan" }));
