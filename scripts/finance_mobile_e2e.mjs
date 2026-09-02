import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core");

const baseUrl = process.env.MOBILE_BASE_URL ?? "http://127.0.0.1:4173";
const apiBaseUrl = process.env.MOBILE_API_BASE_URL ?? "http://127.0.0.1:3100";
const authEmail = process.env.MOBILE_E2E_EMAIL ?? "mobile-e2e@example.invalid";
const authPassword = process.env.MOBILE_E2E_PASSWORD ?? "mobile-e2e-password";
const outputDir = "output/playwright/finance-e2e";
const executablePath = process.env.BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, "0");
const day = String(Math.min(now.getDate(), 28)).padStart(2, "0");
const periodStart = `${year}-${month}-01`;
const periodEnd = `${year}-${month}-${String(new Date(year, now.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
const stamp = (hour, minute) => `${year}-${month}-${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

function csvFile(metadata, header, rows) {
  return [metadata, `导出时间：${periodStart}`, header, ...rows].join("\n") + "\n";
}

async function makeFixtures() {
  const dir = await mkdtemp(join("/tmp", "life-finance-e2e-"));
  const files = {
    bank: join(dir, "bank-e2e.csv"),
    wechat: join(dir, "wechat-e2e.csv"),
    alipay: join(dir, "alipay-e2e.csv"),
    app: join(dir, "bookkeeping-e2e.csv"),
  };
  await writeFile(files.bank, csvFile("招商银行电子回单", "交易时间,金额,收支,交易对方,流水号,备注", [
    `${stamp(12, 0)},35.00,支出,E2E 咖啡,E2E-BANK-001,银行明细`,
  ]), "utf8");
  await writeFile(files.wechat, csvFile("微信支付账单", "交易时间,金额,收支,交易对方,流水号,备注", [
    `${stamp(12, 3)},35.00,支出,E2E 咖啡,E2E-WX-001,微信详情`,
  ]), "utf8");
  await writeFile(files.alipay, csvFile("支付宝交易明细", "交易时间,金额,收支,交易对方,流水号,备注", [
    `${stamp(9, 0)},12.34,支出,E2E 地铁,E2E-ALIPAY-001,支付宝详情`,
    `${stamp(9, 5)},not-an-amount,支出,问题行,E2E-ALIPAY-BAD,应被跳过`,
  ]), "utf8");
  await writeFile(files.app, csvFile("时光序记账模板", "交易时间,金额,收支,交易对方,流水号,备注", [
    `${stamp(18, 0)},5.55,支出,E2E 零食,E2E-APP-001,记账 App 明细`,
  ]), "utf8");
  return { dir, files };
}

async function login(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".auth-card").waitFor();
  await page.locator('input[name="email"]').fill(authEmail);
  await page.locator('input[name="password"]').fill(authPassword);
  await page.getByRole("button", { name: "进入我的家庭" }).click();
  await page.getByRole("navigation", { name: "主导航" }).waitFor();
}

async function auditLayout(page, label) {
  return page.evaluate((name) => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll("button, input, select, textarea")]
      .filter((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
      .map((node) => { const rect = node.getBoundingClientRect(); return { tag: node.tagName, width: Math.round(rect.width), height: Math.round(rect.height), label: node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 30) || node.getAttribute("name") }; });
    return {
      label: name,
      rootWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      narrowControls: controls.filter((item) => item.width < 44 || item.height < 44),
    };
  }, label);
}

async function assertLayout(page, label) {
  const audit = await auditLayout(page, label);
  if (audit.rootScrollWidth > audit.rootWidth) throw new Error(`${label}: horizontal overflow ${audit.rootScrollWidth} > ${audit.rootWidth}`);
  if (audit.narrowControls.length) throw new Error(`${label}: controls below 44pt ${JSON.stringify(audit.narrowControls)}`);
  return audit;
}

async function clickText(page, text) {
  const button = page.getByRole("button", { name: text, exact: true });
  if (await button.count()) {
    await button.click();
    return;
  }
  const loose = page.locator("button:visible").filter({ hasText: text }).last();
  if (await loose.count()) {
    await loose.click();
    return;
  }
  await page.getByText(text, { exact: true }).click();
}

async function openFinance(page) {
  await clickText(page, "财务");
  await page.locator(".finance-page").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".finance-ring-button, .finance-empty-state").first().waitFor({ state: "visible", timeout: 15000 });
}

async function openImportWizard(page) {
  await clickText(page, "财务工具");
  await page.locator(".finance-tools-sheet").waitFor({ state: "visible" });
  await clickText(page, "导入账单");
  await page.locator(".finance-import-sheet").waitFor({ state: "visible" });
}

async function closeImportWizard(page) {
  const button = page.getByRole("button", { name: "返回财务首页", exact: true });
  if (await button.count()) {
    await button.click();
    await page.locator(".finance-import-sheet").waitFor({ state: "detached" });
    return;
  }
  await page.getByRole("button", { name: "关闭账单导入", exact: true }).click();
  await page.locator(".finance-import-sheet").waitFor({ state: "detached" });
}

async function importFile(page, files, sourceLabel, fileKey, expectsCandidate) {
  await openImportWizard(page);
  await page.locator(".import-source-grid button").filter({ hasText: sourceLabel }).click();
  const accountSelect = page.locator(".import-select").first();
  if (await accountSelect.count()) {
    const value = await accountSelect.inputValue();
    if (!value) throw new Error(`${sourceLabel}: import account is not selected`);
  }
  await page.locator('input[type="file"]').setInputFiles(files[fileKey]);
  await page.getByText("SHA-256 已生成", { exact: true }).waitFor({ timeout: 12000 });
  await page.getByRole("button", { name: "上传并登记导入批次", exact: true }).click();
  await page.locator(".header-preview-card").waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: `${outputDir}/import-${fileKey}-header-430x932.png`, fullPage: false });

  const previewRows = page.locator(".header-preview-row");
  if (await previewRows.count() < 3) throw new Error(`${sourceLabel}: header preview missing line-numbered rows`);
  const headerRow = page.locator(".header-preview-row.is-header");
  if (await headerRow.count() !== 1) throw new Error(`${sourceLabel}: header row not selected`);
  const headerText = (await headerRow.first().textContent()) ?? "";
  if (!headerText.includes("交易时间") || !headerText.includes("金额")) throw new Error(`${sourceLabel}: detected header is ${headerText}`);

  await page.getByRole("button", { name: /确认第 .* 行为表头并继续/ }).click();
  await page.locator(".mapping-list").waitFor({ state: "visible" });
  const mappingValues = await page.locator(".mapping-list input").evaluateAll((nodes) => nodes.map((node) => node.value));
  if (!mappingValues.includes("交易时间") || !mappingValues.includes("金额")) throw new Error(`${sourceLabel}: mapping did not keep original field names`);
  await page.getByRole("button", { name: "确认映射并查看关联", exact: true }).click();
  await page.locator(".candidate-list, .import-empty").first().waitFor({ state: "visible", timeout: 15000 });

  if (expectsCandidate) {
    await page.locator(".candidate-card").waitFor({ state: "visible", timeout: 15000 });
    const candidateText = (await page.locator(".candidate-card").first().textContent()) ?? "";
    if (!candidateText.includes("E2E 咖啡")) throw new Error(`${sourceLabel}: reconciliation candidate missing expected merchant`);
    await page.locator(".candidate-actions").getByRole("button", { name: "确认重复", exact: true }).click();
    await page.getByText("已确认", { exact: true }).first().waitFor({ timeout: 12000 });
    await page.screenshot({ path: `${outputDir}/import-${fileKey}-review-430x932.png`, fullPage: false });
  }

  await page.getByRole("button", { name: "查看提交预览", exact: true }).click();
  await page.getByRole("button", { name: "确认写入统一账本", exact: true }).click();
  await page.locator(".commit-summary").waitFor({ state: "visible", timeout: 15000 });
  const summaryText = (await page.locator(".commit-summary").textContent()) ?? "";
  if (!summaryText.includes("新增统一账本")) throw new Error(`${sourceLabel}: commit summary missing`);
  await page.screenshot({ path: `${outputDir}/import-${fileKey}-commit-430x932.png`, fullPage: false });
  await closeImportWizard(page);
}

async function setManualTransaction(page, direction, amount, merchant, accountLabel, toAccountLabel, categoryLabel, filePrefix) {
  await page.getByRole("button", { name: "＋ 新增记账", exact: true }).click();
  await page.locator(".finance-manual-sheet").waitFor({ state: "visible" });
  await page.locator(".manual-direction-switch button").filter({ hasText: direction }).click();
  await page.getByLabel("记账金额").fill(amount);
  const account = page.locator(".finance-manual-sheet select").first();
  if (accountLabel) await account.selectOption({ value: "31000000-0000-0000-0000-0000000000a1" });
  if (direction === "转账") {
    await page.locator(".finance-manual-sheet select").nth(1).selectOption({ value: "32000000-0000-0000-0000-0000000000a1" });
  } else if (categoryLabel) {
    await page.locator(".finance-manual-sheet select").nth(1).selectOption({ label: categoryLabel });
  }
  await page.locator('input[placeholder="例如：晚餐、工资"]').fill(merchant);
  await page.getByRole("button", { name: `保存${direction}`, exact: true }).click();
  await page.locator(".finance-manual-sheet").waitFor({ state: "detached", timeout: 12000 });
  await page.locator(".recent-transaction-row").filter({ hasText: merchant }).first().waitFor({ state: "visible", timeout: 12000 });
  await page.screenshot({ path: `${outputDir}/manual-${filePrefix}-430x932.png`, fullPage: false });
}

async function fetchJson(page, url) {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }, url);
}

async function countsForPeriod(page) {
  const result = await fetchJson(page, `/api/finance/transactions?page=1&page_size=100&start=${periodStart}&end=${periodEnd}`);
  return { items: result.items, total: result.pagination.total };
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const { dir, files } = await makeFixtures();
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const results = [];
  try {
    await login(page);
    await openFinance(page);
    await assertLayout(page, "finance-overview");
    await page.screenshot({ path: `${outputDir}/finance-overview-430x932.png`, fullPage: false });

    const overview = await fetchJson(page, `/api/finance/overview?start=${periodStart}&end=${periodEnd}&granularity=day`);
    if (!overview.summary_cards || overview.summary_cards.length < 4) throw new Error("finance overview summary missing");
    results.push({ overviewCards: true });

    // Summary and chart drilldowns.
    await page.locator(".asset-overview-metric").filter({ hasText: "总资产" }).click();
    await page.locator(".finance-drilldown-sheet").waitFor({ state: "visible" });
    await assertLayout(page, "drilldown-net-asset");
    await page.getByRole("button", { name: "关闭财务明细", exact: true }).click();
    await page.locator(".finance-budget-item").first().waitFor({ state: "visible" });
    await page.locator(".finance-budget-item").first().click();
    await page.locator(".finance-drilldown-sheet").waitFor({ state: "visible" });
    await assertLayout(page, "drilldown-budget");
    await page.getByRole("button", { name: "关闭财务明细", exact: true }).click();
    await page.locator(".chart-heading-main").filter({ hasText: "收入与支出趋势" }).click();
    await page.locator(".finance-drilldown-sheet").waitFor({ state: "visible" });
    await assertLayout(page, "drilldown-trend");
    await page.getByRole("button", { name: "关闭财务明细", exact: true }).click();
    await page.locator(".chart-heading-main").filter({ hasText: "实物资产成本趋势" }).click();
    await page.locator(".finance-drilldown-sheet").waitFor({ state: "visible" });
    await assertLayout(page, "drilldown-asset");
    await page.getByRole("button", { name: "关闭财务明细", exact: true }).click();
    results.push({ drilldowns: ["net-asset", "budget", "trend", "asset"] });

    // Manual income, expense and transfer.
    await setManualTransaction(page, "支出", "88.88", "E2E 午餐", "招商银行", null, "餐饮", "expense");
    await setManualTransaction(page, "收入", "200.00", "E2E 工资", "招商银行", null, null, "income");
    await setManualTransaction(page, "转账", "100.00", "E2E 转现金", "招商银行", "家庭现金", null, "transfer");
    results.push({ manualExpense: true, manualIncome: true, manualTransfer: true });

    // Open one manual record, edit it, then void it.
    await page.locator(".recent-transaction-row").filter({ hasText: "E2E 午餐" }).click();
    await page.locator(".finance-transaction-sheet").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "编辑记录", exact: true }).click();
    await page.locator(".finance-manual-sheet").waitFor({ state: "visible" });
    await page.getByLabel("记账金额").fill("90.00");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page.locator(".finance-manual-sheet").waitFor({ state: "detached" });
    await page.locator(".recent-transaction-row").filter({ hasText: "E2E 午餐" }).waitFor({ state: "visible" });
    await page.locator(".recent-transaction-row").filter({ hasText: "E2E 午餐" }).click();
    await page.locator(".finance-transaction-sheet").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "撤销记录", exact: true }).click();
    await page.getByPlaceholder("填写撤销原因").fill("E2E 审核撤销");
    await page.getByRole("button", { name: "确认撤销", exact: true }).click();
    await page.locator(".finance-transaction-sheet").waitFor({ state: "detached" });
    results.push({ manualEdit: true, manualVoid: true });

    // Real import flow across four source types.
    await importFile(page, files, "银行", "bank", false);
    await importFile(page, files, "微信支付", "wechat", true);
    await importFile(page, files, "支付宝", "alipay", false);
    await importFile(page, files, "记账 App", "app", false);
    const afterImports = await countsForPeriod(page);
    const coffeeCount = afterImports.items.filter((item) => item.merchant === "E2E 咖啡").length;
    if (coffeeCount !== 1) throw new Error(`dedupe failed: expected 1 E2E 咖啡, got ${coffeeCount}`);
    results.push({ imports: ["bank", "wechat", "alipay", "bookkeeping_app"], dedupe: coffeeCount === 1, importedTotal: afterImports.total });

    // Export through the real mobile UI, then verify ready and expiry.
    await clickText(page, "财务工具");
    await page.locator(".finance-tools-sheet").waitFor({ state: "visible" });
    await clickText(page, "导出流水");
    await page.locator(".finance-export-status.ready").waitFor({ state: "visible", timeout: 15000 });
    const downloadHref = await page.locator(".finance-export-status.ready a").getAttribute("href");
    if (!downloadHref) throw new Error("export ready link missing");
    const exportId = downloadHref.split("/").filter(Boolean).at(-2);
    const download = await page.request.get(new URL(downloadHref, baseUrl).toString());
    if (!download.ok()) throw new Error(`export download failed: ${download.status()} ${await download.text()}`);
    const downloadedText = await download.text();
    if (!downloadedText.includes("E2E 咖啡")) throw new Error("export CSV missing imported ledger row");
    const expireResponse = await page.request.get(`${apiBaseUrl}/__e2e/expire-finance-export?id=${encodeURIComponent(exportId ?? "")}`);
    if (!expireResponse.ok()) throw new Error(`expire helper failed: ${expireResponse.status()}`);
    const expiredJob = await fetchJson(page, `/api/finance/exports/${exportId}`);
    if (expiredJob.status !== "expired") throw new Error(`export did not expire: ${expiredJob.status}`);
    const expiredDownload = await page.request.get(`${apiBaseUrl}${downloadHref}`);
    if (expiredDownload.status() !== 409) throw new Error(`expired download should be 409, got ${expiredDownload.status()}`);
    results.push({ export: true, exportId, expiredDownloadRejected: true });

    // Revoke one committed import batch from the mobile UI and verify ledger recovery.
    const beforeRevoke = await countsForPeriod(page);
    await clickText(page, "财务工具");
    await page.locator(".finance-tools-sheet").waitFor({ state: "visible" });
    await clickText(page, "导入账单");
    await page.locator(".finance-import-sheet").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "恢复历史批次", exact: true }).click();
    await page.locator(".import-history-item").filter({ hasText: "bank-e2e.csv" }).click();
    await page.getByRole("button", { name: "撤销这个导入批次", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "撤销这个导入批次", exact: true }).click();
    await page.getByRole("button", { name: "确认撤销", exact: true }).click();
    await page.getByText("这个批次已经撤销", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: `${outputDir}/import-revoked-430x932.png`, fullPage: false });
    await page.getByRole("button", { name: "返回财务首页", exact: true }).click();
    await page.locator(".finance-import-sheet").waitFor({ state: "detached" });
    await page.waitForTimeout(800);
    const afterRevoke = await countsForPeriod(page);
    if (afterRevoke.total >= beforeRevoke.total) throw new Error(`revoke did not reduce ledger: before=${beforeRevoke.total}, after=${afterRevoke.total}`);
    results.push({ revoke: true, beforeRevoke: beforeRevoke.total, afterRevoke: afterRevoke.total });

    const layoutAudits = await Promise.all([
      assertLayout(page, "final-finance-overview"),
    ]);
    results.push({ layoutAudits });
    console.log(JSON.stringify({ ok: true, outputDir, periodStart, periodEnd, results }, null, 2));
  } finally {
    await page.close();
    await context.close();
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
