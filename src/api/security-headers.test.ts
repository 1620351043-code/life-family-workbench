import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API security headers", () => {
  it("adds baseline browser mitigation headers", async () => {
    const app = buildServer({ resolveScope: async () => null });
    try {
      const response = await app.inject({ method: "GET", url: "/api/me" });
      expect(response.statusCode).toBe(401);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["permissions-policy"]).toContain("camera=()");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    } finally {
      await app.close();
    }
  });

  it("adds HSTS on secure deployments", async () => {
    vi.stubEnv("LIFE_DEPLOYMENT_ENV", "staging");
    const app = buildServer({ resolveScope: async () => null });
    try {
      const response = await app.inject({ method: "GET", url: "/healthz" });
      expect(response.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    } finally {
      await app.close();
    }
  });

  it("rejects a cross-origin unsafe API request before auth", async () => {
    const app = buildServer({ resolveScope: async () => null });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: "life.wbutterfly.cn", origin: "https://evil.example.com" },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("CSRF_ORIGIN_DENIED");
    } finally {
      await app.close();
    }
  });

  it("allows a same-origin unsafe request to reach the route", async () => {
    const app = buildServer({ resolveScope: async () => null });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { host: "localhost:3100", origin: "http://localhost:3100" },
        payload: {},
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
