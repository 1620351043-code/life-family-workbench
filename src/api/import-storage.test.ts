import { describe, expect, it, vi } from "vitest";
import { TencentCosObjectStore } from "./import-storage.js";

describe("Tencent COS private object adapter", () => {
  it("uploads private AES256 objects, reads bytes, removes objects, and signs HTTPS downloads", async () => {
    const calls = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ Body: Buffer.from("private-bill") })),
      remove: vi.fn(async () => undefined),
      sign: vi.fn(() => "https://life-prod.cos.ap-guangzhou.myqcloud.com/households/a/original?sign=redacted"),
    };
    const store = new TencentCosObjectStore({
      bucket: "life-prod-1234567890",
      region: "ap-guangzhou",
      secretId: "test-id",
      secretKey: "test-key",
    }, {
      putObject: calls.put,
      getObject: calls.get,
      deleteObject: calls.remove,
      getObjectUrl: calls.sign,
    });

    const key = "households/household-a/finance-imports/batch-a/original";
    await store.put(key, Buffer.from("private-bill"));
    expect(calls.put).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: "life-prod-1234567890",
      Region: "ap-guangzhou",
      Key: key,
      ACL: "private",
      ServerSideEncryption: "AES256",
    }));
    await expect(store.read(key)).resolves.toEqual(Buffer.from("private-bill"));
    await store.remove(key);
    expect(calls.remove).toHaveBeenCalledWith({ Bucket: "life-prod-1234567890", Region: "ap-guangzhou", Key: key });
    expect(store.signedGetUrl(key, new Date(Date.now() + 60_000))).toMatch(/^https:\/\//);
    expect(calls.sign).toHaveBeenCalledWith(expect.objectContaining({ Bucket: "life-prod-1234567890", Region: "ap-guangzhou", Key: key, Sign: true, Method: "GET" }));
  });
});
