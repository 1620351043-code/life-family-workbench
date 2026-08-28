import { DomainError } from "./domain-error.js";
import type { DbClient, FinanceScope } from "./database.js";

export const sensitiveCapabilities = [
  "ai_food_recommendation",
  "ai_topic_summary",
  "ai_finance_insight",
  "ai_cooking_assistant",
  "ai_memory_personalization",
  "media_original",
  "household_export",
] as const;

export type SensitiveCapability = typeof sensitiveCapabilities[number];

export async function hasSensitivePermission(client: DbClient, scope: FinanceScope, capability: SensitiveCapability): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    "SELECT life_family_assert_sensitive_permission($1, $2, $3) AS allowed",
    [scope.householdId, scope.userId, capability],
  );
  return result.rows[0]?.allowed === true;
}

export async function assertSensitivePermission(client: DbClient, scope: FinanceScope, capability: SensitiveCapability): Promise<void> {
  if (!(await hasSensitivePermission(client, scope, capability))) {
    throw new DomainError("SENSITIVE_PERMISSION_DENIED", "这项敏感能力需要家庭所有者逐项授权", 403);
  }
}
