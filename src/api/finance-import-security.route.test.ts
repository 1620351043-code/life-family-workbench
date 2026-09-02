import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { MemoryImportObjectStore } from "./import-storage.js";
import type { FinanceRepository } from "./finance-repository.js";

const scope = { householdId: "10000000-0000-0000-0000-000000000001", userId: "20000000-0000-0000-0000-000000000001" };

describe("finance import upload route security", () => {
  it("rejects unsupported extensions and binary CSV before writing to object storage", async () => {
    const store = new MemoryImportObjectStore();
    const badBytes = Buffer.from("PK\u0003\u0004binary");
    const badHash = createHash("sha256").update(badBytes).digest("hex");
    const badSize = badBytes.byteLength;
    const repository = {
      createImportBatch: async () => ({ id: "batch-1", file_name: "bank.csv", file_size: badSize, file_sha256: badHash, source_type: "bank", status: "created", version: 1 }),
      getImportBatch: async (batchId: string) => ({ id: batchId, file_name: "bank.csv", file_size: badSize, file_sha256: badHash, source_type: "bank", status: "created", version: 1 }),
      markImportBatchUploaded: async () => ({ id: "batch-1", file_name: "bank.csv", file_size: badSize, file_sha256: badHash, source_type: "bank", status: "uploaded", version: 2 }),
    } as unknown as FinanceRepository;
    const app = buildServer({ resolveScope: () => scope, financeFactory: () => repository, importObjectStore: store });

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/finance/import-batches",
      payload: { source_type: "bank", file_name: "bank.pdf", file_size: badSize, file_sha256: badHash, object_key: "pending" },
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().code).toBe("IMPORT_FILE_TYPE_UNSUPPORTED");

    const created = await app.inject({
      method: "POST",
      url: "/api/finance/import-batches",
      payload: { source_type: "bank", file_name: "bank.csv", file_size: badSize, file_sha256: badHash, object_key: "pending" },
    });
    expect(created.statusCode).toBe(201);
    const batchId = created.json().id as string;

    const badUpload = await app.inject({
      method: "POST",
      url: `/api/finance/import-batches/${batchId}/upload`,
      headers: { "content-type": "application/octet-stream" },
      payload: badBytes,
    });
    expect(badUpload.statusCode).toBe(400);
    expect(badUpload.json().code).toBe("IMPORT_FILE_CONTENT_INVALID");
    expect(store.objects.size).toBe(0);
  });
});
