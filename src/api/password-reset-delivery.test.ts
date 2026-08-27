import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpPasswordResetDelivery } from "./password-reset-delivery.js";

afterEach(() => vi.unstubAllGlobals());

describe("HttpPasswordResetDelivery", () => {
  it("sends a reset URL, expiry and optional bearer credential to the configured endpoint", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const delivery = new HttpPasswordResetDelivery("https://mailer.example.test/reset", "https://life.example.test/", "delivery-secret");

    await delivery.sendPasswordReset({ email: "family@example.invalid", token: "single-use-token", expiresAt: "2026-08-27T08:00:00.000Z" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://mailer.example.test/reset");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer delivery-secret" });
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "password_reset",
      recipient: "family@example.invalid",
      reset_url: "https://life.example.test/?reset_token=single-use-token",
      expires_at: "2026-08-27T08:00:00.000Z",
    });
  });

  it("fails closed when the delivery endpoint rejects the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const delivery = new HttpPasswordResetDelivery("https://mailer.example.test/reset", "https://life.example.test/");
    await expect(delivery.sendPasswordReset({ email: "family@example.invalid", token: "token", expiresAt: "2026-08-27T08:00:00.000Z" })).rejects.toThrow("返回 500");
  });
});
