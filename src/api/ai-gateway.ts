export type TopicAiInput = {
  topic: { id: string; title: string; body: string };
  comments: Array<{ id: string; author_name: string; body: string }>;
};

export type TopicAiSummary = {
  summary: string;
  keyPoints: string[];
  commentBody: string;
};

export interface TopicAiProvider {
  readonly name: string;
  readonly model: string | null;
  summarizeTopic(input: TopicAiInput): Promise<TopicAiSummary>;
}

export type FinanceAiFacts = {
  period: { start: string; end: string };
  income: string;
  expense: string;
  net_cash_flow: string;
  top_categories: Array<{ category: string; amount: string }>;
  budgets: Array<{ category: string; amount: string; used: string }>;
  assets: { gross_cost: string; recovery: string; net_cash_cost: string };
};

export type FinanceAiGenerated = { summary: string; key_points: string[]; explanations: string[] };

export interface FinanceAiProvider {
  readonly name: string;
  readonly model: string | null;
  summarizeFinance(input: FinanceAiFacts): Promise<FinanceAiGenerated>;
}

export type HouseholdAiConnectionConfig = { endpoint_url: string; model: string; api_key_ref: string };

export class DeterministicFinanceAiProvider implements FinanceAiProvider {
  readonly name = "deterministic-finance-v1";
  readonly model = null;

  async summarizeFinance(input: FinanceAiFacts): Promise<FinanceAiGenerated> {
    const income = Number(input.income);
    const expense = Number(input.expense);
    const net = Number(input.net_cash_flow);
    const top = input.top_categories[0];
    const overBudget = input.budgets.filter((item) => Number(item.amount) > 0 && Number(item.used) / Number(item.amount) >= 0.8);
    return {
      summary: `本周期确认收入 ¥${formatMoney(income)}，支出 ¥${formatMoney(expense)}，净现金流${net < 0 ? "为负" : "为正"} ¥${formatMoney(Math.abs(net))}。`,
      key_points: [
        top ? `支出最高分类是“${top.category}”，共 ¥${formatMoney(Number(top.amount))}。` : "当前周期还没有足够的支出分类数据。",
        overBudget.length > 0 ? `${overBudget.length} 个预算分类已达到 80% 以上使用率，建议查看明细。` : "当前预算分类没有达到 80% 使用率。",
        Number(input.assets.net_cash_cost) > 0 ? `实物资产本周期净现金成本为 ¥${formatMoney(Number(input.assets.net_cash_cost))}，包含回收 ¥${formatMoney(Number(input.assets.recovery))}。` : "当前周期没有新的实物资产成本事件。",
      ],
      explanations: [
        `趋势解释：本周期净现金流${net < 0 ? "为负，主要由确认支出构成" : "为正，收入高于支出"}。`,
        overBudget.length > 0 ? `预算解释：${overBudget.map((item) => item.category).join("、")}的使用率已接近或超过上限。` : "预算解释：没有发现明显的临界预算。",
        "来源解释：结论只使用当前家庭授权的汇总事实，正式账本不会被 AI 直接改写。",
      ],
    };
  }
}

/** OpenAI-compatible household provider. The API key is resolved at runtime and never stored in PostgreSQL. */
export class OpenAiCompatibleFinanceAiProvider implements FinanceAiProvider {
  readonly name = "openai-compatible";
  readonly model: string;

  constructor(private readonly connection: HouseholdAiConnectionConfig, private readonly apiKey: string) {
    this.model = connection.model;
  }

  async summarizeFinance(input: FinanceAiFacts): Promise<FinanceAiGenerated> {
    const endpoint = this.connection.endpoint_url.replace(/\/$/, "").endsWith("/chat/completions") ? this.connection.endpoint_url : `${this.connection.endpoint_url.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.connection.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是家庭财务解释助手。只能解释输入的汇总事实，不得编造交易，不得执行记账。返回 JSON：summary(string), key_points(string[]), explanations(string[])。" },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`AI_PROVIDER_HTTP_${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI_PROVIDER_EMPTY_RESPONSE");
    const parsed = JSON.parse(content.replace(/^```json\s*/i, "").replace(/\s*```$/, "")) as Partial<FinanceAiGenerated>;
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.key_points) || !Array.isArray(parsed.explanations)) throw new Error("AI_PROVIDER_INVALID_RESPONSE");
    return { summary: parsed.summary.slice(0, 2000), key_points: parsed.key_points.map(String).slice(0, 8), explanations: parsed.explanations.map(String).slice(0, 8) };
  }
}

function formatMoney(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";
}

/**
 * Development provider. It deliberately does not claim to be an LLM: it creates
 * a deterministic, source-linked summary so the approval/audit workflow can be
 * tested before a household-configured AI provider is connected.
 */
export class DeterministicTopicAiProvider implements TopicAiProvider {
  readonly name = "deterministic-dev";
  readonly model = null;

  async summarizeTopic(input: TopicAiInput): Promise<TopicAiSummary> {
    const commentCount = input.comments.length;
    const keyPoints = input.comments.slice(0, 3).map((comment) => `${comment.author_name}：${compact(comment.body, 80)}`);
    if (keyPoints.length === 0) keyPoints.push(`主题内容：${compact(input.topic.body, 80)}`);
    const summary = `围绕「${input.topic.title}」共有 ${commentCount} 条家庭讨论。${compact(input.topic.body, 120)}`;
    const commentBody = `小兔子整理：${summary}\n\n要点：\n${keyPoints.map((point) => `• ${point}`).join("\n")}`;
    return { summary, keyPoints, commentBody };
  }
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
