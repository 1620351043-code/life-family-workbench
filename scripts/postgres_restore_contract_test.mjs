import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const restoreScript = await readFile(new URL("./postgres_restore.sh", import.meta.url), "utf8");

await execFileAsync("bash", ["-n", new URL("./postgres_restore.sh", import.meta.url).pathname]);
assert.match(restoreScript, /I_UNDERSTAND_THIS_RESTORES_ENCRYPTED_POSTGRES_BACKUP/);
assert.match(restoreScript, /LIFE_RESTORE_TARGET_DB/);
assert.match(restoreScript, /life_restore\[0-9a-z_-\]\*/);
assert.match(restoreScript, /sha256sum "\$artifact"/);
assert.match(restoreScript, /--decrypt --output/);
assert.match(restoreScript, /tar -tzf/);
assert.match(restoreScript, /database\.dump\s+integrity\.tsv\s+manifest\.json/);
assert.match(restoreScript, /pg_restore --list/);
assert.match(restoreScript, /current_database\(\)/);
assert.match(restoreScript, /LIFE_RESTORE_ALLOW_REPLACE/);
assert.match(restoreScript, /information_schema\.tables/);
assert.match(restoreScript, /pg_restore --dbname=.*--no-owner --no-acl --clean --if-exists/);
assert.match(restoreScript, /--exit-on-error/);
assert.match(restoreScript, /integrity\.tsv/);
assert.match(restoreScript, /恢复计数不一致/);
assert.doesNotMatch(restoreScript, /echo \$database_url/);
assert.doesNotMatch(restoreScript, /echo \$LIFE_RESTORE_PASSPHRASE_FILE/);

console.log(JSON.stringify({ ok: true, checks: 18, contract: "I-013 isolated PostgreSQL restore" }));
