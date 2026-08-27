export type PasswordResetDeliveryMessage = {
  email: string;
  token: string;
  expiresAt: string;
};

export type PasswordResetDelivery = {
  sendPasswordReset(message: PasswordResetDeliveryMessage): Promise<void>;
};

export class HttpPasswordResetDelivery implements PasswordResetDelivery {
  constructor(
    private readonly endpoint: string,
    private readonly publicAppUrl: string,
    private readonly bearerToken?: string,
  ) {}

  async sendPasswordReset(message: PasswordResetDeliveryMessage): Promise<void> {
    const resetUrl = new URL(this.publicAppUrl);
    resetUrl.searchParams.set("reset_token", message.token);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "password_reset", recipient: message.email, reset_url: resetUrl.toString(), expires_at: message.expiresAt }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`密码重置交付接口返回 ${response.status}`);
  }
}

export function createPasswordResetDeliveryFromEnv(): PasswordResetDelivery | undefined {
  const endpoint = process.env.LIFE_PASSWORD_RESET_DELIVERY_ENDPOINT?.trim();
  const publicAppUrl = process.env.LIFE_PUBLIC_APP_URL?.trim();
  if (!endpoint || !publicAppUrl) return undefined;
  if (process.env.NODE_ENV === "production" && (!endpoint.startsWith("https://") || !publicAppUrl.startsWith("https://"))) throw new Error("生产密码重置交付和公开 App URL 必须使用 HTTPS");
  return new HttpPasswordResetDelivery(endpoint, publicAppUrl, process.env.LIFE_PASSWORD_RESET_DELIVERY_BEARER_TOKEN?.trim());
}
