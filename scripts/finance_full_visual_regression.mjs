import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core");

const baseUrl = process.env.MOBILE_BASE_URL ?? "http://127.0.0.1:4173";
const executablePath = process.env.BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const authEmail = process.env.MOBILE_E2E_EMAIL ?? "mobile-e2e@example.invalid";
const authPassword = process.env.MOBILE_E2E_PASSWORD ?? "mobile-e2e-password";
const outputDir = "output/playwright/finance-full-golden";
const viewports = [
  { name: "430x932", width: 430, height: 932 },
  { name: "390x844", width: 390, height: 844 },
  { name: "320x900", width: 320, height: 900 },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: 1 });
const page = await context.newPage();
const results = [];

async function ensureAuthenticated() {
  await page.locator(".auth-card, .bottom-nav").first().waitFor({ state: "visible", timeout: 15000 });
  if (await page.locator(".auth-card").isVisible()) {
    await page.locator('input[name="email"]').fill(authEmail);
    await page.locator('input[name="password"]').fill(authPassword);
    await page.getByRole("button", { name: "进入我的家庭" }).click();
    await page.getByRole("navigation", { name: "主导航" }).waitFor();
  }
}

async function clickText(name) {
  const exact = page.getByRole("button", { name, exact: true });
  if (await exact.count()) { await exact.click(); await page.waitForTimeout(250); return; }
  const labelled = page.locator("button:visible").filter({ hasText: name }).last();
  if (await labelled.count()) { await labelled.click(); await page.waitForTimeout(250); return; }
  await page.getByText(name, { exact: true }).click();
  await page.waitForTimeout(250);
}

async function reload() {
  await page.goto(`${baseUrl}/?route=finance`, { waitUntil: "domcontentloaded", timeout: 10000 });
  await ensureAuthenticated();
  await page.getByRole("button", { name: "财务" }).click().catch(() => undefined);
  await page.waitForTimeout(250);
  await page.locator(".finance-page").waitFor({ state: "visible", timeout: 15000 });
}

async function waitFor(selector, label = selector) {
  await page.locator(selector).waitFor({ state: "visible", timeout: 12000 });
  return selector;
}

async function audit(slug, viewport) {
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
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
          text: node.textContent?.trim().slice(0, 32),
          className: node.className,
          ariaLabel: node.getAttribute("aria-label"),
        };
      });
    return {
      rootWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      narrowControls: controls.filter((item) => item.width < 44 || item.height < 44),
      pageTextLength: document.body.innerText.trim().length,
      financeVisible: Boolean(document.querySelector(".finance-page")),
      sheetCount: document.querySelectorAll("[role='dialog']").length,
    };
  });
  if (!data.financeVisible) throw new Error(`${slug} ${viewport.name}: finance page not visible`);
  if (data.rootScrollWidth > data.rootWidth) {
    throw new Error(`${slug} ${viewport.name}: horizontal overflow ${data.rootScrollWidth} > ${data.rootWidth}`);
  }
  if (data.narrowControls.length) {
    throw new Error(`${slug} ${viewport.name}: control below 44pt ${JSON.stringify(data.narrowControls)}`);
  }
  if (data.pageTextLength < 10) throw new Error(`${slug} ${viewport.name}: page appears empty`);
  return data;
}

async function capture(slug, viewport, selector) {
  if (selector) await waitFor(selector, slug);
  const data = await audit(slug, viewport);
  const path = `${outputDir}/${slug}-${viewport.name}.png`;
  await page.screenshot({ path, fullPage: false });
  results.push({ slug, viewport: viewport.name, ...data });
  console.log(`  captured ${slug} ${viewport.name}`);
}

async function closeSheet(prefix = "关闭") {
  const close = page.locator(`button[aria-label^='${prefix}']`).last();
  if (await close.count()) {
    await close.click();
    await page.waitForTimeout(250);
  } else {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
}

async function openFinanceTools(viewport) {
  await reload();
  await clickText("财务工具");
  await waitFor(".finance-tools-sheet", "finance-tools");
  await capture("finance-tools", viewport, ".finance-tools-sheet");
}

async function openManagement(viewport) {
  await openFinanceTools(viewport);
  await clickText("账户、分类与预算");
  await waitFor(".finance-management-sheet", "finance-management");
  await capture("finance-management", viewport, ".finance-management-sheet");
}

async function captureManagementSubpages(viewport) {
  await openManagement(viewport);

  await page.getByRole("button", { name: "＋账户", exact: true }).click();
  await waitFor(".finance-account-sheet", "finance-account-editor");
  await capture("finance-account-editor", viewport, ".finance-account-sheet");
  await closeSheet("关闭创建账户");

  await openManagement(viewport);

  await page.getByRole("tab", { name: "预算" }).click();
  await waitFor(".management-panel", "finance-budgets");
  await capture("finance-budgets", viewport, ".management-panel");
  await page.getByRole("button", { name: "＋预算", exact: true }).click();
  await waitFor(".management-editor", "finance-budget-editor");
  await capture("finance-budget-editor", viewport, ".management-editor");
  await closeSheet("关闭预算编辑");

  await page.getByRole("tab", { name: "分类" }).click();
  await waitFor(".management-panel", "finance-categories");
  await capture("finance-categories", viewport, ".management-panel");
  await page.getByRole("button", { name: "＋分类", exact: true }).click();
  await waitFor(".management-editor", "finance-category-editor");
  await capture("finance-category-editor", viewport, ".management-editor");
  await closeSheet("关闭分类编辑");

  await page.getByRole("tab", { name: "权限" }).click();
  await waitFor(".management-panel", "finance-permissions");
  await page.waitForTimeout(700);
  await capture("finance-permissions", viewport, ".management-panel");

  await closeSheet("关闭账户与预算");
}

async function captureAssetSubpages(viewport) {
  await openFinanceTools(viewport);
  await clickText("实物资产");
  await waitFor(".finance-asset-sheet", "finance-assets");
  await capture("finance-assets", viewport, ".finance-asset-sheet");

  await page.getByRole("button", { name: "＋资产", exact: true }).click();
  await waitFor(".asset-editor", "finance-asset-editor");
  await capture("finance-asset-editor", viewport, ".asset-editor");
  await closeSheet("关闭资产编辑");

  const assetRow = page.locator(".asset-row").first();
  if (await assetRow.count()) {
    await assetRow.click();
    await waitFor(".asset-summary-grid", "finance-asset-detail");
    await capture("finance-asset-detail", viewport, ".asset-summary-grid");
    const eventButton = page.getByRole("button", { name: "＋事件", exact: true });
    if (await eventButton.count() && await eventButton.isEnabled()) {
      await eventButton.click();
      await waitFor(".asset-editor", "finance-asset-event-editor");
      await capture("finance-asset-event-editor", viewport, ".asset-editor");
      await closeSheet("关闭资产事件编辑");
    }
  }

  await closeSheet("关闭实物资产");
}

async function captureImportSubpages(viewport) {
  await openFinanceTools(viewport);
  await clickText("导入账单");
  await waitFor(".finance-import-sheet", "finance-import");
  await capture("finance-import", viewport, ".finance-import-sheet");

  await page.getByRole("button", { name: "恢复历史批次", exact: true }).click();
  await waitFor(".import-history-panel", "finance-import-history");
  await capture("finance-import-history", viewport, ".import-history-panel");
  await page.getByRole("button", { name: "关闭", exact: true }).first().click();
  await page.waitForTimeout(200);

  await closeSheet("关闭账单导入");
}

async function captureMainFinanceStates(viewport) {
  await reload();
  await capture("finance-overview", viewport, ".finance-ring-button");

  await reload();
  const manual = page.getByRole("button", { name: "＋ 新增记账", exact: true });
  if (await manual.count() && await manual.isEnabled()) {
    await manual.click();
    await waitFor(".finance-manual-sheet", "finance-manual");
    await capture("finance-manual", viewport, ".finance-manual-sheet");
    await closeSheet("关闭新增记账");
  }

  await reload();
  const transactions = page.getByRole("button", { name: "查看全部", exact: true });
  if (await transactions.count()) {
    await transactions.click();
    await waitFor(".finance-transactions-sheet", "finance-transactions");
    await capture("finance-transactions", viewport, ".finance-transactions-sheet");
    const row = page.locator(".finance-drilldown-row").first();
    if (await row.count()) {
      await row.click();
      await waitFor(".finance-transaction-sheet", "finance-transaction-detail");
      await capture("finance-transaction-detail", viewport, ".finance-transaction-sheet");
      await closeSheet("关闭统一账单详情");
    }
    await closeSheet("关闭全部流水");
  }

  await reload();
  const ai = page.getByRole("button", { name: /AI 解读/ });
  if (await ai.count()) {
    await ai.click();
    await waitFor(".finance-ai-sheet", "finance-ai");
    await page.waitForTimeout(600);
    await capture("finance-ai", viewport, ".finance-ai-sheet");
    await closeSheet("关闭财务 AI 解读");
  }

  await reload();
  const customRange = page.getByRole("button", { name: "自定义", exact: true });
  if (await customRange.count()) {
    await customRange.click();
    await waitFor(".finance-custom-range", "finance-custom-range");
    await capture("finance-custom-range", viewport, ".finance-custom-range");
  }

  await reload();
  const ringCenter = page.locator(".finance-ring-center").first();
  if (await ringCenter.count()) {
    await ringCenter.click();
    await waitFor(".finance-drilldown-sheet", "finance-drilldown-budget");
    await capture("finance-drilldown-budget", viewport, ".finance-drilldown-sheet");
    await closeSheet("关闭财务明细");
  }

  await reload();
  const trendHeading = page.locator(".chart-heading-main").filter({ hasText: "收入与支出趋势" }).first();
  if (await trendHeading.count()) {
    await trendHeading.click();
    await waitFor(".finance-drilldown-sheet", "finance-drilldown-trend");
    await capture("finance-drilldown-trend", viewport, ".finance-drilldown-sheet");
    await closeSheet("关闭财务明细");
  }

  await reload();
  const assetTrendHeading = page.locator(".chart-heading-main").filter({ hasText: "实物资产成本趋势" }).first();
  if (await assetTrendHeading.count()) {
    await assetTrendHeading.click();
    await waitFor(".finance-drilldown-sheet", "finance-drilldown-asset");
    await capture("finance-drilldown-asset", viewport, ".finance-drilldown-sheet");
    await closeSheet("关闭财务明细");
  }
}

try {
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    console.log(`\nfinance visual regression: ${viewport.name}`);
    await captureMainFinanceStates(viewport);
    await captureManagementSubpages(viewport);
    await captureAssetSubpages(viewport);
    await captureImportSubpages(viewport);
  }
} finally {
  await page.close();
  await browser.close();
}

console.log(JSON.stringify({ ok: true, viewports: viewports.map((item) => item.name), screenshots: results.map((item) => `${outputDir}/${item.slug}-${item.viewport}.png`), results }, null, 2));
