import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core");
const baseUrl = process.env.MOBILE_BASE_URL ?? "http://127.0.0.1:4173";
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const authEmail = process.env.MOBILE_E2E_EMAIL ?? "mobile-e2e@example.invalid";
const authPassword = process.env.MOBILE_E2E_PASSWORD ?? "mobile-e2e-password";
const outputDir = "output/playwright/finance-golden";
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
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  ownsBrowser = true;
}
const context = browser.contexts()[0] ?? await browser.newContext();
const page = await context.newPage();
const results = [];

try {
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/?route=finance`, { waitUntil: "networkidle" });
    await page.locator(".auth-card, .bottom-nav").first().waitFor({ state: "visible", timeout: 15000 });
    if (await page.locator(".auth-card").isVisible()) {
      await page.locator('input[name="email"]').fill(authEmail);
      await page.locator('input[name="password"]').fill(authPassword);
      await page.getByRole("button", { name: "进入我的家庭" }).click();
      await page.getByRole("navigation", { name: "主导航" }).waitFor();
    }
    await page.getByRole("button", { name: "财务" }).click().catch(() => undefined);
    await page.locator(".finance-ring-button").waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(250);
    const audit = await page.evaluate(() => {
      const root = document.documentElement;
      const controls = [...document.querySelectorAll("button, input, select, textarea")]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            tag: node.tagName,
            width: rect.width,
            height: rect.height,
            text: node.textContent?.trim().slice(0, 24),
            className: node.className,
            ariaLabel: node.getAttribute("aria-label"),
          };
        });
      return {
        rootWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        narrowControls: controls.filter((item) => item.width < 44 || item.height < 44),
        financeVisible: Boolean(document.querySelector(".finance-page")),
        budgetRingWidth: document.querySelector(".finance-ring-button")?.getBoundingClientRect().width ?? 0,
        budgetLegendCount: document.querySelectorAll(".finance-budget-item").length,
      };
    });
    if (!audit.financeVisible) throw new Error(`${viewport.name}: finance page not visible`);
    if (audit.budgetRingWidth <= 0) throw new Error(`${viewport.name}: budget ring not rendered (${audit.budgetRingWidth})`);
    if (audit.budgetLegendCount === 0) throw new Error(`${viewport.name}: budget legend not rendered`);
    if (audit.rootScrollWidth > audit.rootWidth) throw new Error(`${viewport.name}: horizontal overflow ${audit.rootScrollWidth} > ${audit.rootWidth}`);
    if (audit.narrowControls.length) throw new Error(`${viewport.name}: control below 44pt ${JSON.stringify(audit.narrowControls)}`);
    await page.screenshot({ path: `${outputDir}/finance-${viewport.name}.png`, fullPage: false });
    results.push({ viewport, ...audit });
  }
} finally {
  await page.close();
  if (ownsBrowser) await browser.close();
}

console.log(JSON.stringify({ ok: true, screenshots: viewports.map((viewport) => `${outputDir}/finance-${viewport.name}.png`), results }, null, 2));
