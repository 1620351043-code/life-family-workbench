import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9223";

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page = context.pages()[0];
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(baseUrl, { waitUntil: "networkidle" });

const initial = await page.locator("#life-lowfi").innerText();
const finance = initial;
await page.screenshot({ path: "output/playwright/life-low-fi-finance-overview.png", fullPage: true });
await page.locator('button[data-action="budget-drill"]').first().click();
await page.waitForTimeout(250);
const drilldown = await page.locator("#life-lowfi").innerText();
await page.locator('button[data-action="import"]').first().click();
await page.waitForTimeout(50);
const importPage = await page.locator("#life-lowfi").innerText();

await page.screenshot({ path: "output/playwright/life-low-fi-finance-import.png", fullPage: true });

const result = {
  viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  initialHasFinance: initial.includes("财务"),
  financeHasRing: finance.includes("本月预算总览") && finance.includes("同心环"),
  drilldownHasRef: drilldown.includes("drilldown_ref"),
  drilldownHasServerItem: drilldown.includes("家庭餐饮"),
  importHasBank: importPage.includes("银行账单") && importPage.includes("表头第 4 行"),
  screenshots: ["output/playwright/life-low-fi-finance-overview.png", "output/playwright/life-low-fi-finance-import.png"],
};

console.log(JSON.stringify(result));
await browser.close();
