import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("./life_health_check.ts", import.meta.url), "utf8");
const service = await readFile(new URL("../deploy/life-staging-health.service.example", import.meta.url), "utf8");
const timer = await readFile(new URL("../deploy/life-staging-health.timer.example", import.meta.url), "utf8");
const environment = await readFile(new URL("../deploy/staging-health.env.example", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

for (const marker of [
  "checkApi",
  "checkDatabase",
  "checkQueue",
  "checkObjectStorage",
  "checkAi",
  "checkDisk",
  "checkCertificate",
  "sendAlert",
]) {
  assert.match(script, new RegExp(marker));
}

assert.match(service, /EnvironmentFile=\/etc\/life\/staging-health\.env/);
assert.match(service, /ExecStart=\/usr\/bin\/npm run health:check/);
assert.match(service, /ProtectSystem=strict/);
assert.match(service, /NoNewPrivileges=true/);
assert.match(service, /ReadWritePaths=\/var\/lib\/life\/staging-imports/);
assert.match(service, /User=root/);
assert.match(service, /StandardOutput=journal/);
assert.match(timer, /OnCalendar=\*-\*-\* \*:00\/5:00/);
assert.match(timer, /Persistent=true/);
assert.match(timer, /Unit=life-staging-health\.service/);
assert.match(environment, /LIFE_HEALTH_DATABASE_URL=/);
assert.match(environment, /LIFE_HEALTH_API_URL=/);
assert.match(environment, /LIFE_HEALTH_TLS_HOST=/);
assert.match(environment, /LIFE_HEALTH_STORAGE_ROOT=/);
assert.match(environment, /LIFE_HEALTH_PG_DATA_DIR=/);
assert.match(environment, /LIFE_HEALTH_DISK_CRITICAL_PERCENT=90/);
assert.match(environment, /LIFE_HEALTH_ALERT_WEBHOOK_URL=/);
assert.doesNotMatch(environment, /LIFE_COS_SECRET_KEY=\S/);
assert.doesNotMatch(script, /console\.log\(.*(process\.env\[?['"]?(DATABASE_URL|LIFE_HEALTH_DATABASE_URL|LIFE_COS|LIFE_AI_SECRET|LIFE_HEALTH_ALERT_WEBHOOK_TOKEN))/);
assert.equal(typeof packageJson.scripts["health:check"], "string");
assert.equal(typeof packageJson.scripts["health:contract"], "string");

console.log(JSON.stringify({ ok: true, checks: 30, contract: "I-011 staging health check" }));
