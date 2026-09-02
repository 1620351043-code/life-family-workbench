import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core");

const baseUrl = process.env.MOBILE_BASE_URL ?? "http://127.0.0.1:4173";
const executablePath = process.env.BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const authEmail = process.env.MOBILE_E2E_EMAIL ?? "mobile-e2e@example.invalid";
const authPassword = process.env.MOBILE_E2E_PASSWORD ?? "mobile-e2e-password";
const outputDir = "/Users/wrt/Documents/Codex/2026-08-23/new-chat/output/playwright/ui-pages";
const viewport = { width: 430, height: 932 };

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
const page = await context.newPage();
const captured = [];
let authenticationEnsured = false;

async function save(name, fullPage = true) {
  const path = `${outputDir}/${name}.png`;
  await page.screenshot({ path, fullPage });
  captured.push(path);
}

async function ensureAuthenticated() {
  if (authenticationEnsured) return;
  await page.locator(".auth-card, .bottom-nav").first().waitFor({ state: "visible", timeout: 15000 });
  if (await page.locator(".auth-card").isVisible()) {
    await page.locator('input[name="email"]').fill(authEmail);
    await page.locator('input[name="password"]').fill(authPassword);
    await page.getByRole("button", { name: "进入我的家庭" }).click();
    await page.getByRole("navigation", { name: "主导航" }).waitFor();
  }
  authenticationEnsured = true;
}

async function reload() {
  // Vite keeps a hot-reload websocket open, so networkidle can never be a
  // reliable readiness signal for this catalog run.
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForTimeout(250);
  await ensureAuthenticated();
}

async function clickText(name) {
  const button = page.getByRole("button", { name, exact: true });
  if (await button.count()) {
    await button.click();
  } else {
    // Navigation buttons include a decorative icon in their accessible name
    // (for example "￥财务"). Match the visible label after the exact pass.
    const labelledButton = page.locator("button:visible").filter({ hasText: name }).last();
    if (await labelledButton.count()) {
      await labelledButton.click();
    } else {
      // A few sheet cards are rendered as clickable cards rather than semantic
      // buttons; use their exact visible label as the fallback target.
      await page.getByText(name, { exact: true }).click();
    }
  }
  await page.waitForTimeout(250);
}

try {
  async function openFinance() {
    await reload();
    await clickText("财务");
    await page.getByRole("heading", { name: "这段时间，钱都去哪儿了？" }).waitFor();
  }

  async function openFinanceTools() {
    await openFinance();
    const toolsButton = page.getByRole("button", { name: "财务工具", exact: true });
    if (!(await toolsButton.count())) return false;
    await toolsButton.click();
    await page.waitForTimeout(250);
    return true;
  }

  async function openFood() {
    await reload();
    await clickText("吃什么");
    await page.getByRole("heading", { name: "今晚吃什么？" }).waitFor();
  }

  await reload();
  await save("01-family-space-home");

  await openFood();
  await save("02-food-home");

  await openFood();
  await page.locator(".food-quick-card").filter({ hasText: "智能搭配" }).click();
  await save("20-food-pairing", false);

  await openFood();
  await page.getByRole("button", { name: /西红柿牛腩/ }).first().click();
  await save("14-food-confirm", false);

  await page.getByRole("button", { name: "确认并进入 HowToCook" }).click();
  await page.getByRole("tab", { name: "烹饪步骤" }).click();
  await save("16-food-cook-steps", false);

  await page.getByRole("button", { name: "生成采购清单" }).click();
  await save("15-food-shopping", false);

  await openFood();
  await page.locator(".food-quick-card").filter({ hasText: "菜谱搜索" }).click();
  await page.getByLabel("搜索菜谱").fill("西兰花");
  await save("17-food-search", false);

  await openFood();
  await page.locator(".food-quick-card").filter({ hasText: "吃过什么" }).click();
  await save("18-food-history", false);

  await openFood();
  await page.locator(".food-quick-card").filter({ hasText: "长期习惯" }).click();
  await save("19-food-preferences", false);

  await reload();
  await clickText("更多");
  await save("03-more-placeholder");

  await openFinance();
  await save("04-finance-overview");

  if (await openFinanceTools()) {
    await save("05-finance-tools", false);
  } else {
    await save("05-finance-permission-gated", false);
  }

  if (await openFinanceTools()) {
    await clickText("账户、分类与预算");
    await save("06-account-budget-management", false);
  }

  if (await openFinanceTools()) {
    await clickText("账户、分类与预算");
    const accountButton = page.getByRole("button", { name: "＋账户", exact: true });
    if (await accountButton.count() && await accountButton.isEnabled()) {
      await accountButton.click();
      await page.waitForTimeout(150);
      await save("07-account-editor", false);
    }
  }

  if (await openFinanceTools()) {
    await clickText("实物资产");
    await save("08-physical-assets", false);
  }

  if (await openFinanceTools()) {
    await clickText("实物资产");
    const assetButton = page.getByRole("button", { name: /家用设备/ }).first();
    if (await assetButton.count()) {
      await assetButton.click();
      await page.waitForTimeout(150);
      await save("09-physical-asset-detail", false);
    }
  }

  if (await openFinanceTools()) {
    await clickText("导入账单");
    await save("10-import-wizard", false);
  }

  await openFinance();
  const manualButton = page.getByRole("button", { name: "＋ 新增记账" });
  if (await manualButton.count() && await manualButton.isEnabled()) {
    await manualButton.click();
    await page.waitForTimeout(150);
    await save("11-manual-bookkeeping", false);
  }

  await openFinance();
  const allTransactions = page.getByRole("button", { name: "查看全部" });
  if (await allTransactions.count()) {
    await allTransactions.click();
    await page.waitForTimeout(250);
    await save("12-all-transactions", false);
  }

  await openFinance();
  const aiButton = page.getByRole("button", { name: /AI 解读/ });
  if (await aiButton.count()) {
    await aiButton.click();
    await page.waitForTimeout(400);
    await save("13-finance-ai", false);
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: true, viewport, screenshots: captured }, null, 2));
