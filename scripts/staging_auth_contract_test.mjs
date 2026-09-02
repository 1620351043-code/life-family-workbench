import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertHttpRedirect,
  assertHttpsHeaders,
  assertSessionCookie,
  createStagingIdentity,
  loadStagingAuthConfig,
  parseMailboxPayload,
  stagingAuthConfirmation,
} from "./staging_auth_contract.mjs";

const config = loadStagingAuthConfig({
  LIFE_E2E_CONFIRM: stagingAuthConfirmation,
  LIFE_E2E_BASE_URL: "https://staging.life.example.test",
  LIFE_E2E_MAILBOX_ENDPOINT: "https://mailbox.example.test/messages/latest",
  LIFE_E2E_MAILBOX_BEARER_TOKEN: "test-only-secret",
  LIFE_E2E_EMAIL_TEMPLATE: "life-e2e+{nonce}@example.test",
});
const identity = createStagingIdentity(config, "20260828-abc");
assert.equal(identity.email, "life-e2e+20260828-abc@example.test");

const reset = parseMailboxPayload({ messages: [{
  recipient: identity.email,
  reset_url: `https://staging.life.example.test/?reset_token=${"a".repeat(48)}`,
  received_at: "2026-08-28T12:00:00Z",
  message_id: "message-1",
}] }, identity.email, config.baseUrl);
assert.ok(reset);
assert.equal(reset.messageId, "message-1");

assert.deepEqual(assertSessionCookie([{ name: "life_session", domain: "staging.life.example.test", httpOnly: true, secure: true, sameSite: "Lax" }], "life_session", config.baseUrl), {
  name: "life_session", httpOnly: true, secure: true, sameSite: "Lax",
});
assert.equal(assertHttpsHeaders({
  url: "https://staging.life.example.test/",
  status: 200,
  headers: new Headers({ "strict-transport-security": "max-age=31536000; includeSubDomains" }),
}).hsts.includes("31536000"), true);
assert.equal(assertHttpRedirect(new Response(null, { status: 308, headers: { location: "https://staging.life.example.test/" } }), config.baseUrl).status, 308);

assert.throws(() => loadStagingAuthConfig({
  LIFE_E2E_CONFIRM: stagingAuthConfirmation,
  LIFE_E2E_BASE_URL: "http://staging.life.example.test",
  LIFE_E2E_MAILBOX_ENDPOINT: "https://mailbox.example.test/messages/latest",
  LIFE_E2E_MAILBOX_BEARER_TOKEN: "test-only-secret",
  LIFE_E2E_EMAIL_TEMPLATE: "life-e2e+{nonce}@example.test",
}), /HTTPS/);
assert.throws(() => parseMailboxPayload({ reset_url: `https://evil.example.test/?reset_token=${"a".repeat(48)}`, recipient: identity.email }, identity.email, config.baseUrl), /域名不一致/);

const caddyTemplate = await readFile(new URL("../deploy/life-staging.Caddyfile.example", import.meta.url), "utf8");
assert.match(caddyTemplate, /handle \/api\/\*/);
assert.match(caddyTemplate, /handle \/healthz/);

console.log(JSON.stringify({ ok: true, checks: 10, contract: "B-011 staging auth black-box" }));
