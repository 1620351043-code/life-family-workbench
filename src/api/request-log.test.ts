import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { privacyHash, redactUrl, type RequestLogEntry } from "./request-log.js";

describe("request log privacy helpers", () => {
  it("hashes values deterministically and never returns raw input", () => {
    const value = "privacy@example.com";
    const first = privacyHash(value);
    const second = privacyHash(value);
    expect(first).toBe(second);
    expect(first).not.toContain("privacy");
    expect(first).toMatch(/^[a-f0-9]{16}$/);
  });

  it("removes query strings from route labels", () => {
    expect(redactUrl("/api/finance/transactions?start=2026-01-01")).toBe("/api/finance/transactions");
  });
});

describe("server request logging", () => {
  it("emits a redacted structured entry and returns the same trace id", async () => {
    const entries: RequestLogEntry[] = [];
    const app = buildServer({
      resolveScope: async () => null,
      requestLogSink: (entry) => entries.push(entry),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: "localhost:3100", origin: "http://localhost:3100" },
        payload: { email: "privacy@example.com", password: "super-secret-password" },
      });
      expect(response.statusCode).toBe(503);
      expect(typeof response.headers["x-request-id"]).toBe("string");
      expect(entries).toHaveLength(1);
      const serialized = JSON.stringify(entries[0]);
      expect(serialized).not.toContain("privacy@example.com");
      expect(serialized).not.toContain("super-secret-password");
      expect(entries[0].trace_id).toBe(response.headers["x-request-id"]);
      expect(entries[0].route).toBe("/api/auth/login");
      expect(entries[0].ip_hash).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      await app.close();
    }
  });
});
