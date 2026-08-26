import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wrt/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core");
const baseUrl = process.env.MOBILE_BASE_URL ?? "http://localhost:4173";
const executablePath = process.env.BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function openFood(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.getByRole("button", { name: /吃什么/ }).click();
  await page.getByRole("heading", { name: "今晚吃什么？" }).waitFor();
}

const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  await openFood(page);
  assert.equal(await page.getByRole("region", { name: "今日推荐" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /小兔子推荐/ }).count(), 1);

  await page.getByRole("button", { name: /西红柿牛腩/ }).first().click();
  assert.equal(await page.getByRole("heading", { name: "这份菜单合适吗？" }).count(), 1);
  await page.getByRole("button", { name: "增加份数" }).click();
  assert.equal(await page.getByText("3 人", { exact: true }).count(), 1);

  await page.getByRole("button", { name: "确认并进入 HowToCook" }).click();
  assert.equal(await page.getByRole("heading", { name: "西红柿牛腩" }).count(), 1);
  await page.getByRole("tab", { name: "烹饪步骤" }).click();
  await page.locator(".step-row").first().click();
  assert.equal(await page.locator(".step-row.done").count(), 1);

  await page.getByRole("button", { name: "生成采购清单" }).click();
  assert.equal(await page.getByRole("heading", { name: "把这顿饭带回家" }).count(), 1);
  const firstShoppingItem = page.locator(".shopping-item").first();
  assert.match(await firstShoppingItem.innerText(), /牛腩/);
  await page.getByLabel("牛腩实际价格").fill("38.50");
  assert.equal(await page.getByLabel("牛腩实际价格").inputValue(), "38.50");
  await firstShoppingItem.getByRole("button", { name: "牛腩标记为已准备" }).click();
  assert.equal(await page.locator(".shopping-item.checked").count(), 1);
  assert.equal(await page.locator(".shopping-group-label.settled").count(), 1);
  assert.equal(await page.locator(".shopping-item.owned").filter({ hasText: "生姜" }).count(), 1);
  await page.getByRole("button", { name: "生成财务成本草稿" }).click();
  assert.equal(await page.getByText("已生成成本草稿", { exact: true }).count(), 1);

  await openFood(page);
  await page.locator(".food-quick-card").filter({ hasText: "菜谱搜索" }).click();
  await page.getByLabel("搜索菜谱").fill("西兰花");
  assert.equal(await page.locator(".search-result-card").count(), 1);

  await openFood(page);
  await page.locator(".food-quick-card").filter({ hasText: "吃过什么" }).click();
  await page.getByRole("button", { name: "午餐", exact: true }).click();
  assert.equal(await page.locator(".history-row").count(), 1);

  const narrow = await browser.newPage({ viewport: { width: 320, height: 900 } });
  await openFood(narrow);
  const overflow = await narrow.evaluate(() => document.body.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  await narrow.getByRole("button", { name: /西红柿牛腩/ }).first().click();
  await narrow.getByRole("button", { name: "确认并进入 HowToCook" }).click();
  await narrow.getByRole("button", { name: "生成采购清单" }).click();
  const narrowShoppingOverflow = await narrow.evaluate(() => document.body.scrollWidth > window.innerWidth);
  assert.equal(narrowShoppingOverflow, false);
  await narrow.close();
  console.log(JSON.stringify({ ok: true, flow: "recommendation → confirmation → HowToCook → shopping → search → history", viewports: ["430x932", "320x900"] }));
} finally {
  await browser.close();
}
