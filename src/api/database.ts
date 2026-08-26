export type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
  rowCount?: number | null;
};

export type DbClient = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
  release?: () => void;
};

export type DbPool = {
  connect(): Promise<DbClient>;
};

export type FinanceScope = {
  householdId: string;
  userId: string;
};

export async function inTenantTransaction<T>(pool: DbPool, scope: FinanceScope, work: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.household_id', $2, true)", [scope.userId, scope.householdId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    client.release?.();
  }
}
