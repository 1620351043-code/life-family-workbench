import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core");
const baseUrl = process.env.MOBILE_BASE_URL ?? "http://127.0.0.1:4173";
const apiBaseUrl = process.env.MOBILE_API_BASE_URL ?? "http://127.0.0.1:3100";
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const outputDir = "output/playwright/auth-vertical";
const seededEmail = process.env.MOBILE_E2E_EMAIL ?? "mobile-e2e@example.invalid";
const seededPassword = process.env.MOBILE_E2E_PASSWORD ?? "mobile-e2e-password";
const viewports = [
  { name: "430x932", width: 430, height: 932 },
  { name: "390x844", width: 390, height: 844 },
  { name: "320x900", width: 320, height: 900 },
];

await mkdir(outputDir, { recursive: true });
let browser;
let ownsBrowser = false;
try {
  browser = await chromium.connectOverCDP(cdpUrl);
} catch {
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  ownsBrowser = true;
}

const results = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.locator(".auth-card").waitFor();
      const audit = await auditAuthLayout(page);
      if (audit.rootScrollWidth > audit.rootWidth) throw new Error(`${viewport.name}: horizontal overflow ${audit.rootScrollWidth} > ${audit.rootWidth}`);
      if (audit.narrowControls.length) throw new Error(`${viewport.name}: control below 44pt ${JSON.stringify(audit.narrowControls)}`);
      await page.screenshot({ path: `${outputDir}/login-${viewport.name}.png`, fullPage: false });

      await page.locator('input[name="email"]').fill(seededEmail);
      await page.locator('input[name="password"]').fill("wrong-password");
      await page.getByRole("button", { name: "进入我的家庭" }).click();
      await page.locator(".auth-message").filter({ hasText: "邮箱或密码不正确" }).waitFor();

      await page.locator('input[name="password"]').fill(seededPassword);
      await page.getByRole("button", { name: "进入我的家庭" }).click();
      await page.getByRole("navigation", { name: "主导航" }).waitFor();
      await page.getByRole("button", { name: "更多" }).click();
      await page.locator(".identity-card").getByText("移动端验收家庭", { exact: true }).waitFor();
      await page.locator(".identity-card").getByText(seededEmail, { exact: true }).waitFor();
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("navigation", { name: "主导航" }).waitFor();
      await page.getByRole("button", { name: "更多" }).click();
      await page.locator(".identity-card").getByText("移动端验收家庭", { exact: true }).waitFor();
      await page.getByRole("button", { name: "退出登录" }).click();
      await page.getByRole("button", { name: "进入我的家庭" }).waitFor();
      results.push({ viewport, ...audit, wrongCredentialFeedback: true, cookieLogin: true, sessionRestoredByMe: true, logout: true });
    } finally {
      await page.close();
      await context.close();
    }
  }

  const dataRightsContext = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const dataRightsPage = await dataRightsContext.newPage();
  try {
    await dataRightsPage.goto(baseUrl, { waitUntil: "networkidle" });
    await dataRightsPage.locator('input[name="email"]').fill(seededEmail);
    await dataRightsPage.locator('input[name="password"]').fill(seededPassword);
    await dataRightsPage.getByRole("button", { name: "进入我的家庭" }).click();
    await dataRightsPage.getByRole("navigation", { name: "主导航" }).waitFor();
    await dataRightsPage.getByRole("button", { name: "更多" }).click();
    await dataRightsPage.getByRole("button", { name: "数据与安全" }).click();
    await dataRightsPage.getByText("你的数据边界，清楚可见。", { exact: true }).waitFor();
    await dataRightsPage.getByText("365", { exact: true }).waitFor();
    const dataRightsAudits = [];
    for (const viewport of viewports) {
      await dataRightsPage.setViewportSize({ width: viewport.width, height: viewport.height });
      await dataRightsPage.locator(".content-scroll").evaluate((node) => { node.scrollTop = 0; });
      const layout = await auditAuthLayout(dataRightsPage);
      if (layout.rootScrollWidth > layout.rootWidth) throw new Error(`data rights ${viewport.name}: horizontal overflow ${layout.rootScrollWidth} > ${layout.rootWidth}`);
      if (layout.overflowingContainers.length) throw new Error(`data rights ${viewport.name}: nested horizontal overflow ${JSON.stringify(layout.overflowingContainers)}`);
      if (layout.narrowControls.length) throw new Error(`data rights ${viewport.name}: control below 44pt ${JSON.stringify(layout.narrowControls)}`);
      await dataRightsPage.screenshot({ path: `${outputDir}/data-rights-${viewport.name}.png`, fullPage: false });
      await dataRightsPage.locator(".danger-zone").scrollIntoViewIfNeeded();
      await dataRightsPage.screenshot({ path: `${outputDir}/data-rights-danger-${viewport.name}.png`, fullPage: false });
      dataRightsAudits.push({ viewport, ...layout });
    }
    await dataRightsPage.setViewportSize({ width: 430, height: 932 });
    await dataRightsPage.getByRole("button", { name: "申请删除家庭" }).scrollIntoViewIfNeeded();
    await dataRightsPage.getByRole("button", { name: "申请删除家庭" }).click();
    await dataRightsPage.getByRole("dialog").waitFor();
    const confirmAudit = await auditAuthLayout(dataRightsPage);
    if (confirmAudit.narrowControls.length) throw new Error(`data rights confirmation: control below 44pt ${JSON.stringify(confirmAudit.narrowControls)}`);
    await dataRightsPage.screenshot({ path: `${outputDir}/data-rights-confirm-430x932.png`, fullPage: false });
    await dataRightsPage.locator('input[placeholder="删除家庭"]').fill("删除家庭");
    await dataRightsPage.getByRole("button", { name: "开始 14 天等待期" }).click();
    await dataRightsPage.locator(".active-plans").waitFor();
    await dataRightsPage.getByRole("button", { name: "撤销计划" }).waitFor();
    await dataRightsPage.locator(".active-plans").scrollIntoViewIfNeeded();
    await dataRightsPage.screenshot({ path: `${outputDir}/data-rights-scheduled-430x932.png`, fullPage: false });
    await dataRightsPage.getByRole("button", { name: "撤销计划" }).click();
    await dataRightsPage.locator(".active-plans").waitFor({ state: "detached" });
    await dataRightsPage.getByRole("button", { name: "返回更多" }).click();
    await dataRightsPage.getByRole("button", { name: "退出登录" }).click();
    await dataRightsPage.getByRole("button", { name: "进入我的家庭" }).waitFor();
    results.push({ dataRightsFlow: true, retentionDays: 365, householdWaitDays: 14, scheduleAndCancel: true, honestFullArchiveBoundary: true, dataRightsAudits, confirmAudit });
  } finally {
    await dataRightsPage.close();
    await dataRightsContext.close();
  }

  const registrationContext = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const registrationPage = await registrationContext.newPage();
  const registrationEmail = `new-family-${Date.now()}@example.invalid`;
  try {
    await registrationPage.goto(baseUrl, { waitUntil: "networkidle" });
    await registrationPage.getByRole("tab", { name: "创建家庭" }).click();
    await registrationPage.locator('input[name="household-name"]').fill("星光小兔之家");
    await registrationPage.locator('input[name="email"]').fill(registrationEmail);
    await registrationPage.locator('input[name="password"]').fill("new-family-password");
    await registrationPage.locator('.auth-consent input[type="checkbox"]').check();
    const registrationAudit = await auditAuthLayout(registrationPage);
    if (registrationAudit.rootScrollWidth > registrationAudit.rootWidth) throw new Error(`registration: horizontal overflow ${registrationAudit.rootScrollWidth} > ${registrationAudit.rootWidth}`);
    if (registrationAudit.narrowControls.length) throw new Error(`registration: control below 44pt ${JSON.stringify(registrationAudit.narrowControls)}`);
    await registrationPage.screenshot({ path: `${outputDir}/register-430x932.png`, fullPage: false });
    await registrationPage.getByRole("button", { name: "注册并进入 Life" }).click();
    await registrationPage.getByRole("navigation", { name: "主导航" }).waitFor();
    await registrationPage.getByRole("button", { name: "更多" }).click();
    await registrationPage.locator(".identity-card").getByText("星光小兔之家", { exact: true }).waitFor();
    await registrationPage.locator(".identity-card").getByText(registrationEmail, { exact: true }).waitFor();
    await registrationPage.screenshot({ path: `${outputDir}/registered-family-430x932.png`, fullPage: false });
    await registrationPage.getByRole("button", { name: "退出登录" }).click();
    await registrationPage.locator('input[name="email"]').fill(registrationEmail);
    await registrationPage.locator('input[name="password"]').fill("new-family-password");
    await registrationPage.getByRole("button", { name: "进入我的家庭" }).click();
    await registrationPage.getByRole("navigation", { name: "主导航" }).waitFor();
    await registrationPage.getByRole("button", { name: "更多" }).click();
    await registrationPage.locator(".identity-card").getByText("星光小兔之家", { exact: true }).waitFor();
    await registrationPage.getByRole("button", { name: "退出登录" }).click();
    await registrationPage.getByRole("button", { name: "进入我的家庭" }).waitFor();

    await registrationPage.getByRole("button", { name: "忘记密码？" }).click();
    await registrationPage.locator('input[name="email"]').fill(registrationEmail);
    await registrationPage.getByRole("button", { name: "发送重置链接" }).click();
    await registrationPage.getByText("请检查你的邮箱", { exact: true }).waitFor();
    await registrationPage.screenshot({ path: `${outputDir}/reset-requested-430x932.png`, fullPage: false });
    const tokenResponse = await registrationPage.request.get(`${apiBaseUrl}/__e2e/password-reset-token?email=${encodeURIComponent(registrationEmail)}`);
    if (!tokenResponse.ok()) throw new Error(`password reset token unavailable: ${tokenResponse.status()}`);
    const resetToken = (await tokenResponse.json()).token;
    await registrationPage.goto(`${baseUrl}/?reset_token=${encodeURIComponent(resetToken)}`, { waitUntil: "networkidle" });
    await registrationPage.getByText("设置一个新密码", { exact: true }).waitFor();
    const resetAudits = [];
    for (const viewport of viewports) {
      await registrationPage.setViewportSize({ width: viewport.width, height: viewport.height });
      const layout = await auditAuthLayout(registrationPage);
      if (layout.rootScrollWidth > layout.rootWidth) throw new Error(`reset ${viewport.name}: horizontal overflow ${layout.rootScrollWidth} > ${layout.rootWidth}`);
      if (layout.narrowControls.length) throw new Error(`reset ${viewport.name}: control below 44pt ${JSON.stringify(layout.narrowControls)}`);
      await registrationPage.screenshot({ path: `${outputDir}/reset-layout-${viewport.name}.png`, fullPage: false });
      resetAudits.push({ viewport, ...layout });
    }
    await registrationPage.setViewportSize({ width: 430, height: 932 });
    await registrationPage.locator('input[name="new-password"]').fill("renewed-family-password");
    await registrationPage.locator('input[name="confirm-password"]').fill("renewed-family-password");
    const resetAudit = await auditAuthLayout(registrationPage);
    if (resetAudit.rootScrollWidth > resetAudit.rootWidth) throw new Error(`reset: horizontal overflow ${resetAudit.rootScrollWidth} > ${resetAudit.rootWidth}`);
    if (resetAudit.narrowControls.length) throw new Error(`reset: control below 44pt ${JSON.stringify(resetAudit.narrowControls)}`);
    await registrationPage.screenshot({ path: `${outputDir}/reset-password-430x932.png`, fullPage: false });
    await registrationPage.getByRole("button", { name: "更新密码" }).click();
    await registrationPage.getByText("密码已经更新", { exact: true }).waitFor();
    await registrationPage.screenshot({ path: `${outputDir}/reset-complete-430x932.png`, fullPage: false });
    await registrationPage.getByRole("button", { name: "使用新密码登录" }).click();
    await registrationPage.getByRole("button", { name: "进入我的家庭" }).waitFor();
    await registrationPage.locator('input[name="email"]').fill(registrationEmail);
    await registrationPage.locator('input[name="password"]').fill("new-family-password");
    await registrationPage.getByRole("button", { name: "进入我的家庭" }).click();
    await Promise.race([
      registrationPage.locator(".auth-message").waitFor(),
      registrationPage.getByRole("navigation", { name: "主导航" }).waitFor(),
    ]);
    if (await registrationPage.getByRole("navigation", { name: "主导航" }).isVisible().catch(() => false)) throw new Error("old password remained valid after reset");
    const oldPasswordError = await registrationPage.locator(".auth-message").textContent();
    if (!oldPasswordError?.includes("邮箱或密码不正确")) throw new Error(`unexpected old-password response: ${oldPasswordError}`);
    await registrationPage.locator('input[name="password"]').fill("renewed-family-password");
    await registrationPage.getByRole("button", { name: "进入我的家庭" }).click();
    await registrationPage.getByRole("navigation", { name: "主导航" }).waitFor();
    await registrationPage.getByRole("button", { name: "更多" }).click();
    await registrationPage.locator(".identity-card").getByText("星光小兔之家", { exact: true }).waitFor();
    await registrationPage.getByRole("button", { name: "退出登录" }).click();
    await registrationPage.getByRole("button", { name: "进入我的家庭" }).waitFor();
    results.push({ registration: true, relogin: true, passwordReset: true, oldPasswordRevoked: true, logout: true, registrationEmail, household: "星光小兔之家", ...registrationAudit, resetAudit, resetAudits });
  } finally {
    await registrationPage.close();
    await registrationContext.close();
  }

  const invitationContext = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const invitationPage = await invitationContext.newPage();
  const invitedEmail = `invited-child-${Date.now()}@example.invalid`;
  try {
    await invitationPage.goto(baseUrl, { waitUntil: "networkidle" });
    await invitationPage.locator('input[name="email"]').fill(seededEmail);
    await invitationPage.locator('input[name="password"]').fill(seededPassword);
    await invitationPage.getByRole("button", { name: "进入我的家庭" }).click();
    await invitationPage.getByRole("navigation", { name: "主导航" }).waitFor();
    await invitationPage.getByRole("button", { name: "更多" }).click();
    await invitationPage.getByRole("button", { name: "家庭与成员" }).click();
    await invitationPage.getByText("家里的人", { exact: true }).waitFor();
    await invitationPage.getByText(seededEmail, { exact: true }).waitFor();
    const memberAudits = [];
    for (const viewport of viewports) {
      await invitationPage.setViewportSize({ width: viewport.width, height: viewport.height });
      const layout = await auditAuthLayout(invitationPage);
      if (layout.rootScrollWidth > layout.rootWidth) throw new Error(`members ${viewport.name}: horizontal overflow ${layout.rootScrollWidth} > ${layout.rootWidth}`);
      if (layout.overflowingContainers.length) throw new Error(`members ${viewport.name}: nested horizontal overflow ${JSON.stringify(layout.overflowingContainers)}`);
      if (layout.narrowControls.length) throw new Error(`members ${viewport.name}: control below 44pt ${JSON.stringify(layout.narrowControls)}`);
      await invitationPage.screenshot({ path: `${outputDir}/members-owner-${viewport.name}.png`, fullPage: false });
      memberAudits.push({ viewport, ...layout });
    }
    await invitationPage.setViewportSize({ width: 430, height: 932 });
    await invitationPage.getByRole("button", { name: "＋ 邀请成员" }).click();
    await invitationPage.getByRole("button", { name: /^儿童/ }).click();
    await invitationPage.getByRole("button", { name: "生成一次性邀请码" }).click();
    await invitationPage.getByText("邀请已经准备好", { exact: true }).waitFor();
    const inviteCode = (await invitationPage.locator(".created-invite code").textContent())?.trim();
    if (!inviteCode) throw new Error("created invitation code missing");
    await invitationPage.screenshot({ path: `${outputDir}/invite-created-430x932.png`, fullPage: false });
    await invitationPage.getByRole("button", { name: "完成" }).click();
    await invitationPage.getByRole("button", { name: "返回更多" }).click();
    await invitationPage.getByRole("button", { name: "退出登录" }).click();
    await invitationPage.getByRole("button", { name: "进入我的家庭" }).waitFor();

    await invitationPage.goto(`${baseUrl}/?invite_token=${encodeURIComponent(inviteCode)}`, { waitUntil: "networkidle" });
    await invitationPage.getByText("加入一个家庭", { exact: true }).waitFor();
    await invitationPage.getByText("移动端验收家庭", { exact: true }).waitFor();
    await invitationPage.locator('input[name="email"]').fill(invitedEmail);
    await invitationPage.locator('input[name="password"]').fill("invited-child-password");
    await invitationPage.locator('.auth-consent input[type="checkbox"]').check();
    const joinAudit = await auditAuthLayout(invitationPage);
    if (joinAudit.rootScrollWidth > joinAudit.rootWidth) throw new Error(`join: horizontal overflow ${joinAudit.rootScrollWidth} > ${joinAudit.rootWidth}`);
    if (joinAudit.overflowingContainers.length) throw new Error(`join: nested horizontal overflow ${JSON.stringify(joinAudit.overflowingContainers)}`);
    if (joinAudit.narrowControls.length) throw new Error(`join: control below 44pt ${JSON.stringify(joinAudit.narrowControls)}`);
    await invitationPage.screenshot({ path: `${outputDir}/invite-join-430x932.png`, fullPage: false });
    await invitationPage.getByRole("button", { name: "注册并加入家庭" }).click();
    await invitationPage.getByRole("navigation", { name: "主导航" }).waitFor();
    await invitationPage.getByRole("button", { name: "更多" }).click();
    await invitationPage.getByRole("button", { name: "家庭与成员" }).click();
    await invitationPage.getByText(invitedEmail, { exact: true }).waitFor();
    await invitationPage.getByText("儿童成员 · 当前账号", { exact: true }).waitFor();
    await invitationPage.screenshot({ path: `${outputDir}/members-child-430x932.png`, fullPage: false });
    await invitationPage.getByRole("button", { name: "查看我的敏感权限" }).click();
    await invitationPage.getByText("敏感权限", { exact: true }).waitFor();
    await invitationPage.locator(".member-permission-sheet .permission-capability").first().waitFor();
    if (await invitationPage.locator(".member-permission-sheet .permission-capability").count() !== 7) throw new Error("child sensitive permission list is incomplete");
    if (await invitationPage.locator('.member-permission-sheet .permission-capability[aria-pressed="true"]').count()) throw new Error("child sensitive permissions were not denied by default");
    await invitationPage.screenshot({ path: `${outputDir}/permissions-child-readonly-430x932.png`, fullPage: false });
    await invitationPage.getByRole("button", { name: "关闭敏感权限" }).click();
    await invitationPage.getByRole("button", { name: "返回更多" }).click();
    await invitationPage.getByRole("button", { name: "退出登录" }).click();

    await invitationPage.locator('input[name="email"]').fill(seededEmail);
    await invitationPage.locator('input[name="password"]').fill(seededPassword);
    await invitationPage.getByRole("button", { name: "进入我的家庭" }).click();
    await invitationPage.getByRole("navigation", { name: "主导航" }).waitFor();
    await invitationPage.getByRole("button", { name: "更多" }).click();
    await invitationPage.getByRole("button", { name: "家庭与成员" }).click();
    await invitationPage.getByRole("button", { name: `管理 ${invitedEmail} 的敏感权限` }).click();
    await invitationPage.getByText("敏感权限", { exact: true }).waitFor();
    await invitationPage.locator(".member-permission-sheet .permission-capability").first().waitFor();
    if (await invitationPage.locator(".member-permission-sheet .permission-capability").count() !== 7) throw new Error("owner sensitive permission list is incomplete");
    const permissionAudits = [];
    for (const viewport of viewports) {
      await invitationPage.setViewportSize({ width: viewport.width, height: viewport.height });
      const layout = await auditAuthLayout(invitationPage);
      if (layout.rootScrollWidth > layout.rootWidth) throw new Error(`permissions ${viewport.name}: horizontal overflow ${layout.rootScrollWidth} > ${layout.rootWidth}`);
      if (layout.overflowingContainers.length) throw new Error(`permissions ${viewport.name}: nested horizontal overflow ${JSON.stringify(layout.overflowingContainers)}`);
      if (layout.narrowControls.length) throw new Error(`permissions ${viewport.name}: control below 44pt ${JSON.stringify(layout.narrowControls)}`);
      await invitationPage.screenshot({ path: `${outputDir}/permissions-owner-${viewport.name}.png`, fullPage: false });
      permissionAudits.push({ viewport, ...layout });
    }
    await invitationPage.setViewportSize({ width: 430, height: 932 });
    await invitationPage.getByRole("button", { name: /主题摘要/ }).click();
    await invitationPage.getByRole("button", { name: "确认授权" }).click();
    await invitationPage.locator(".permission-success").filter({ hasText: "主题摘要已授权" }).waitFor();
    if (await invitationPage.getByRole("button", { name: /主题摘要/ }).getAttribute("aria-pressed") !== "true") throw new Error("topic summary permission did not update in place");
    await invitationPage.screenshot({ path: `${outputDir}/permission-granted-430x932.png`, fullPage: false });
    await invitationPage.getByRole("button", { name: "调整角色" }).click();
    await invitationPage.locator(".family-role-sheet .family-role-segments button").filter({ hasText: "成人" }).click();
    await invitationPage.getByRole("button", { name: "确认修改" }).click();
    await invitationPage.locator(".permission-member-hero").getByText("成人成员 · 逐项授权", { exact: true }).waitFor();
    await invitationPage.locator('.member-permission-sheet .permission-capability[aria-pressed="true"]').waitFor({ state: "detached" });
    await invitationPage.screenshot({ path: `${outputDir}/member-role-updated-430x932.png`, fullPage: false });
    results.push({ invitationFlow: true, invitedEmail, oneHousehold: "移动端验收家庭", childJoined: true, childPermissionsDefaultDenied: true, sensitivePermissionGranted: true, roleChangeResetPermissions: true, ownerRoleUpdated: true, memberAudits, permissionAudits, joinAudit });
  } finally {
    await invitationPage.close();
    await invitationContext.close();
  }
} finally {
  if (ownsBrowser) await browser.close();
}

console.log(JSON.stringify({ ok: true, outputDir, results }, null, 2));

async function auditAuthLayout(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll("button, input")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { tag: node.tagName, type: node.getAttribute("type"), width: Math.round(rect.width), height: Math.round(rect.height), label: node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 24) || node.getAttribute("name") };
      });
    return {
      rootWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      authVisible: Boolean(document.querySelector(".auth-card")),
      overflowingContainers: [...document.querySelectorAll(".content-scroll, .sheet, .auth-frame")].map((node) => ({
        className: node.className,
        clientWidth: Math.round(node.clientWidth),
        scrollWidth: Math.round(node.scrollWidth),
        scrollLeft: Math.round(node.scrollLeft),
      })).filter((item) => item.scrollWidth > item.clientWidth + 1 || item.scrollLeft !== 0),
      narrowControls: controls.filter((item) => item.width < 44 || item.height < 44),
    };
  });
}
