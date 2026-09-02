import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  assertHttpRedirect,
  assertHttpsHeaders,
  assertSessionCookie,
  createStagingIdentity,
  loadStagingAuthConfig,
  parseMailboxPayload,
} from "./staging_auth_contract.mjs";

const config = loadStagingAuthConfig();
const startedAt = new Date();
const nonce = `${startedAt.toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
const identity = createStagingIdentity(config, nonce);
const initialPassword = `Life!A-${randomBytes(12).toString("base64url")}`;
const renewedPassword = `Life!B-${randomBytes(12).toString("base64url")}`;
const householdName = `B011-${nonce}`;
const viewports = [
  { name: "430x932", width: 430, height: 932 },
  { name: "390x844", width: 390, height: 844 },
  { name: "320x900", width: 320, height: 900 },
];

await mkdir(config.outputDir, { recursive: true });
const transport = await verifyTransport(config.baseUrl);
const chromium = loadChromium(config.playwrightModule);
const browser = await chromium.launch({ headless: true, executablePath: config.browserExecutable });
const report = {
  ok: false,
  contract: "B-011 staging auth black-box",
  started_at: startedAt.toISOString(),
  base_origin: config.baseUrl.origin,
  test_email_domain: identity.emailDomain,
  household_marker: householdName,
  transport,
  checks: {},
};

let ownerContext;
let secondSessionContext;
let resetContext;
try {
  ownerContext = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(config.baseUrl.toString(), { waitUntil: "networkidle", timeout: config.timeoutMs });
  await ownerPage.getByRole("tab", { name: "创建家庭" }).click();
  await ownerPage.locator('input[name="household-name"]').fill(householdName);
  await ownerPage.locator('input[name="email"]').fill(identity.email);
  await ownerPage.locator('input[name="password"]').fill(initialPassword);
  await ownerPage.locator('.auth-consent input[type="checkbox"]').check();
  await ownerPage.getByRole("button", { name: "注册并进入 Life" }).click();
  await ownerPage.getByRole("navigation", { name: "主导航" }).waitFor({ timeout: config.timeoutMs });
  const registeredCookie = assertSessionCookie(await ownerContext.cookies(config.baseUrl.toString()), config.cookieName, config.baseUrl);
  await ownerPage.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "更多", exact: true }).click();
  await ownerPage.locator(".identity-card").getByText(householdName, { exact: true }).waitFor();
  await ownerPage.screenshot({ path: `${config.outputDir}/registered-430x932.png`, fullPage: false });
  report.checks.registration = true;
  report.checks.secure_cookie = registeredCookie;

  secondSessionContext = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const secondPage = await secondSessionContext.newPage();
  await login(secondPage, config.baseUrl, identity.email, initialPassword, config.timeoutMs);
  assertSessionCookie(await secondSessionContext.cookies(config.baseUrl.toString()), config.cookieName, config.baseUrl);
  const meBeforeReset = await secondSessionContext.request.get(new URL("api/me", config.baseUrl).toString());
  if (meBeforeReset.status() !== 200) throw new Error(`B-011 第二会话 /api/me 预期 200，实际 ${meBeforeReset.status()}`);
  report.checks.second_session = true;

  await ownerPage.getByRole("button", { name: "退出登录" }).click();
  await ownerPage.getByRole("button", { name: "进入我的家庭" }).waitFor();
  await ownerPage.getByRole("button", { name: "忘记密码？" }).click();
  await ownerPage.locator('input[name="email"]').fill(identity.email);
  const resetRequestedAt = new Date();
  await ownerPage.getByRole("button", { name: "发送重置链接" }).click();
  await ownerPage.getByText("请检查你的邮箱", { exact: true }).waitFor({ timeout: config.timeoutMs });
  await ownerPage.screenshot({ path: `${config.outputDir}/reset-requested-430x932.png`, fullPage: false });
  const delivered = await pollMailbox(config, identity.email, resetRequestedAt);
  report.checks.delivery = { received: true, received_at: delivered.receivedAt, message_id_present: Boolean(delivered.messageId) };

  resetContext = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const resetPage = await resetContext.newPage();
  await resetPage.goto(delivered.resetUrl, { waitUntil: "networkidle", timeout: config.timeoutMs });
  await resetPage.getByText("设置一个新密码", { exact: true }).waitFor();
  const resetLayouts = [];
  for (const viewport of viewports) {
    await resetPage.setViewportSize({ width: viewport.width, height: viewport.height });
    const layout = await auditLayout(resetPage);
    if (layout.rootScrollWidth > layout.rootWidth) throw new Error(`B-011 reset ${viewport.name} 横向溢出`);
    if (layout.narrowControls.length) throw new Error(`B-011 reset ${viewport.name} 存在小于 44pt 的控件`);
    await resetPage.screenshot({ path: `${config.outputDir}/reset-${viewport.name}.png`, fullPage: false });
    resetLayouts.push({ viewport: viewport.name, ...layout });
  }
  await resetPage.setViewportSize({ width: 430, height: 932 });
  await resetPage.locator('input[name="new-password"]').fill(renewedPassword);
  await resetPage.locator('input[name="confirm-password"]').fill(renewedPassword);
  await resetPage.getByRole("button", { name: "更新密码" }).click();
  await resetPage.getByText("密码已经更新", { exact: true }).waitFor({ timeout: config.timeoutMs });
  report.checks.password_reset = { completed: true, responsive_layouts: resetLayouts };

  const revokedResponse = await secondSessionContext.request.get(new URL("api/me", config.baseUrl).toString());
  if (revokedResponse.status() !== 401) throw new Error(`B-011 密码重置后旧会话未撤销：${revokedResponse.status()}`);
  report.checks.old_session_revoked = true;

  await ownerPage.getByRole("button", { name: "返回登录" }).click();
  await ownerPage.locator('input[name="email"]').fill(identity.email);
  await ownerPage.locator('input[name="password"]').fill(initialPassword);
  await ownerPage.getByRole("button", { name: "进入我的家庭" }).click();
  await ownerPage.locator(".auth-message").filter({ hasText: "邮箱或密码不正确" }).waitFor({ timeout: config.timeoutMs });
  report.checks.old_password_revoked = true;

  await ownerPage.locator('input[name="password"]').fill(renewedPassword);
  await ownerPage.getByRole("button", { name: "进入我的家庭" }).click();
  await ownerPage.getByRole("navigation", { name: "主导航" }).waitFor({ timeout: config.timeoutMs });
  await ownerPage.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "财务", exact: true }).click();
  await ownerPage.locator(".finance-page").waitFor({ timeout: config.timeoutMs });
  await ownerPage.screenshot({ path: `${config.outputDir}/finance-after-reset-430x932.png`, fullPage: false });
  report.checks.new_password_login = true;
  report.checks.finance_session = true;

  await ownerPage.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "更多", exact: true }).click();
  await ownerPage.getByRole("button", { name: "退出登录" }).click();
  const afterLogout = await ownerContext.request.get(new URL("api/me", config.baseUrl).toString());
  if (afterLogout.status() !== 401) throw new Error(`B-011 退出后 /api/me 未失效：${afterLogout.status()}`);
  report.checks.logout = true;
  report.ok = true;
} finally {
  report.completed_at = new Date().toISOString();
  await writeFile(`${config.outputDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await resetContext?.close();
  await secondSessionContext?.close();
  await ownerContext?.close();
  await browser.close();
}

console.log(JSON.stringify({
  ok: report.ok,
  contract: report.contract,
  base_origin: report.base_origin,
  test_email_domain: report.test_email_domain,
  checks: Object.keys(report.checks),
  report: `${config.outputDir}/report.json`,
}, null, 2));

function loadChromium(preferredModule) {
  const require = createRequire(import.meta.url);
  const candidates = [
    preferredModule,
    "playwright",
    "playwright-core",
    "/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded.chromium) return loaded.chromium;
    } catch {
      // Try the next explicitly supported runtime.
    }
  }
  throw new Error("B-011 找不到 Playwright；请设置 LIFE_E2E_PLAYWRIGHT_MODULE");
}

async function verifyTransport(baseUrl) {
  const appResponse = await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const https = assertHttpsHeaders(appResponse);
  const healthResponse = await fetch(new URL("healthz", baseUrl), { signal: AbortSignal.timeout(15_000) });
  if (!healthResponse.ok) throw new Error(`B-011 /healthz 不可用：${healthResponse.status}`);
  const health = await healthResponse.json();
  if (health?.status !== "ok") throw new Error("B-011 /healthz 返回内容异常");
  const httpUrl = new URL(baseUrl);
  httpUrl.protocol = "http:";
  httpUrl.port = "";
  const redirectResponse = await fetch(httpUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const redirect = assertHttpRedirect(redirectResponse, baseUrl);
  return { https: true, hsts: https.hsts, healthz: true, http_redirect_status: redirect.status };
}

async function pollMailbox(currentConfig, recipient, requestedAt) {
  const deadline = Date.now() + currentConfig.timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = new URL(currentConfig.mailboxEndpoint);
    endpoint.searchParams.set("recipient", recipient);
    endpoint.searchParams.set("after", requestedAt.toISOString());
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${currentConfig.mailboxBearerToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204 || response.status === 404) {
      await delay(2_000);
      continue;
    }
    if (!response.ok) throw new Error(`B-011 测试邮箱接口返回 ${response.status}`);
    const found = parseMailboxPayload(await response.json(), recipient, currentConfig.baseUrl);
    if (found) return found;
    await delay(2_000);
  }
  throw new Error("B-011 在等待时间内没有收到密码重置邮件");
}

async function login(page, baseUrl, email, password, timeoutMs) {
  await page.goto(baseUrl.toString(), { waitUntil: "networkidle", timeout: timeoutMs });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "进入我的家庭" }).click();
  await page.getByRole("navigation", { name: "主导航" }).waitFor({ timeout: timeoutMs });
}

async function auditLayout(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const narrowControls = [...document.querySelectorAll("button, input, select, textarea, [role='button']")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
      })
      .map((node) => ({ tag: node.tagName, text: node.textContent?.trim().slice(0, 40), width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) }));
    return { rootWidth: root.clientWidth, rootScrollWidth: root.scrollWidth, narrowControls };
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
