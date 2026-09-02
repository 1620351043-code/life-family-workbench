import { describe, expect, it } from "vitest";
import { isSameOriginRequest, isUnsafeMethod } from "./same-origin.js";

const request = (method: string, headers: Record<string, string> = {}) => ({
  method,
  headers,
  protocol: "http",
  hostname: "localhost",
});

describe("same-origin request guard", () => {
  it("only guards unsafe HTTP methods", () => {
    expect(isUnsafeMethod("GET")).toBe(false);
    expect(isUnsafeMethod("HEAD")).toBe(false);
    expect(isUnsafeMethod("OPTIONS")).toBe(false);
    expect(isUnsafeMethod("POST")).toBe(true);
    expect(isUnsafeMethod("PATCH")).toBe(true);
    expect(isUnsafeMethod("DELETE")).toBe(true);
  });

  it("allows non-browser unsafe requests without Origin or Referer", () => {
    expect(isSameOriginRequest(request("POST"))).toBe(true);
  });

  it("allows the exact same origin", () => {
    expect(isSameOriginRequest(request("POST", { host: "localhost:3100", origin: "http://localhost:3100" }))).toBe(true);
  });

  it("rejects a cross-origin request", () => {
    expect(isSameOriginRequest(request("POST", { host: "life.wbutterfly.cn", origin: "https://evil.example.com" }))).toBe(false);
  });

  it("rejects a null or malformed origin", () => {
    expect(isSameOriginRequest(request("POST", { host: "localhost:3100", origin: "null" }))).toBe(false);
    expect(isSameOriginRequest(request("POST", { host: "localhost:3100", origin: "not a url" }))).toBe(false);
  });

  it("uses Referer when Origin is absent", () => {
    expect(isSameOriginRequest(request("POST", { host: "localhost:3100", referer: "http://localhost:3100/settings" }))).toBe(true);
    expect(isSameOriginRequest(request("POST", { host: "localhost:3100", referer: "https://evil.example.com/settings" }))).toBe(false);
  });

  it("accepts the configured public app origin", () => {
    expect(isSameOriginRequest(
      request("POST", { host: "127.0.0.1:3100", origin: "https://life.wbutterfly.cn" }),
      "https://life.wbutterfly.cn/",
    )).toBe(true);
  });
});
