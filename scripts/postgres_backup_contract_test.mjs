import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const backupScript = await readFile(new URL("./postgres_backup.sh", import.meta.url), "utf8");
const service = await readFile(new URL("../deploy/life-staging-postgres-backup.service.example", import.meta.url), "utf8");
const timer = await readFile(new URL("../deploy/life-staging-postgres-backup.timer.example", import.meta.url), "utf8");
const environment = await readFile(new URL("../deploy/staging-backup.env.example", import.meta.url), "utf8");

await execFileAsync("bash", ["-n", new URL("./postgres_backup.sh", import.meta.url).pathname]);
assert.match(backupScript, /I_UNDERSTAND_THIS_CREATES_ENCRYPTED_POSTGRES_BACKUPS/);
assert.match(backupScript, /pg_dump --dbname=.*--format=custom/);
assert.match(backupScript, /pg_restore --list/);
assert.match(backupScript, /--symmetric --cipher-algo AES256/);
assert.match(backupScript, /rclone copy --checksum/);
assert.match(backupScript, /rclone check --checksum/);
assert.match(backupScript, /remote_verified_at=/);
assert.match(backupScript, /LIFE_BACKUP_PRUNE_REMOTE/);
assert.match(backupScript, /\/var\/backups\/life\/\*\/postgres/);
assert.doesNotMatch(backupScript, /echo \$DATABASE_URL/);

assert.match(service, /EnvironmentFile=\/etc\/life\/staging-migration\.env/);
assert.match(service, /EnvironmentFile=\/etc\/life\/staging-backup\.env/);
assert.match(service, /UMask=0077/);
assert.match(service, /ProtectSystem=strict/);
assert.match(timer, /OnCalendar=\*-\*-\* 03:20:00/);
assert.match(timer, /Persistent=true/);
assert.match(environment, /LIFE_BACKUP_LOCAL_RETENTION_DAYS=7/);
assert.match(environment, /LIFE_BACKUP_REMOTE_RETENTION_DAYS=35/);

console.log(JSON.stringify({ ok: true, checks: 17, contract: "I-012 encrypted PostgreSQL backup" }));
