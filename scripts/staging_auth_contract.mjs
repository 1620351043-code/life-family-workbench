const CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_STAGING_DATA";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`B-011 缺少 ${name}`);
  return value;
}

function httpsUrl(value, name) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`B-011 ${name} 必须使用 HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`B-011 ${name} 不能在 URL 中携带凭据`);
  return parsed;
}

export function loadStagingAuthConfig(env = process.env) {
  if (required(env, "LIFE_E2E_CONFIRM") !== CONFIRMATION) {
    throw new Error(`B-011 LIFE_E2E_CONFIRM 必须为 ${CONFIRMATION}`);
  }
  const baseUrl = httpsUrl(required(env, "LIFE_E2E_BASE_URL"), "LIFE_E2E_BASE_URL");
  const mailboxEndpoint = httpsUrl(required(env, "LIFE_E2E_MAILBOX_ENDPOINT"), "LIFE_E2E_MAILBOX_ENDPOINT");
  const emailTemplate = required(env, "LIFE_E2E_EMAIL_TEMPLATE").toLowerCase();
  if (!emailTemplate.includes("{nonce}") || !emailTemplate.includes("@")) {
    throw new Error("B-011 LIFE_E2E_EMAIL_TEMPLATE 必须包含 {nonce} 和邮箱域名");
  }
  if (baseUrl.search || baseUrl.hash) throw new Error("B-011 LIFE_E2E_BASE_URL 不能包含查询参数或锚点");
  const timeoutMs = Number(env.LIFE_E2E_TIMEOUT_MS || 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new Error("B-011 LIFE_E2E_TIMEOUT_MS 必须在 30000 到 600000 之间");
  }
  return {
    baseUrl: new URL(baseUrl.pathname.endsWith("/") ? baseUrl : `${baseUrl.toString()}/`),
    mailboxEndpoint,
    mailboxBearerToken: required(env, "LIFE_E2E_MAILBOX_BEARER_TOKEN"),
    emailTemplate,
    cookieName: env.LIFE_E2E_COOKIE_NAME?.trim() || "life_session",
    browserExecutable: env.BROWSER_EXECUTABLE?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    playwrightModule: env.LIFE_E2E_PLAYWRIGHT_MODULE?.trim(),
    timeoutMs,
    outputDir: env.LIFE_E2E_OUTPUT_DIR?.trim() || "output/playwright/staging-auth",
  };
}

export function createStagingIdentity(config, nonce) {
  const normalizedNonce = String(nonce).replace(/[^a-z0-9-]/gi, "").toLowerCase();
  if (!normalizedNonce) throw new Error("B-011 测试 nonce 不能为空");
  const email = config.emailTemplate.replaceAll("{nonce}", normalizedNonce);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("B-011 测试邮箱模板生成了无效地址");
  return { email, emailDomain: email.slice(email.lastIndexOf("@") + 1) };
}

export function parseMailboxPayload(payload, expectedRecipient, baseUrl) {
  const records = Array.isArray(payload?.messages) ? payload.messages : payload?.reset_url ? [payload] : [];
  if (!records.length) return null;
  const matching = records.find((item) => String(item?.recipient || "").toLowerCase() === expectedRecipient.toLowerCase());
  if (!matching) return null;
  const resetUrl = httpsUrl(String(matching.reset_url || ""), "邮箱返回的 reset_url");
  if (resetUrl.origin !== baseUrl.origin) throw new Error("B-011 邮箱中的重置链接与应用域名不一致");
  const token = resetUrl.searchParams.get("reset_token");
  if (!token || token.length < 32) throw new Error("B-011 邮箱中的重置链接缺少有效 token");
  return {
    resetUrl: resetUrl.toString(),
    receivedAt: typeof matching.received_at === "string" ? matching.received_at : null,
    messageId: typeof matching.message_id === "string" ? matching.message_id : null,
  };
}

export function assertSessionCookie(cookies, cookieName, baseUrl) {
  const cookie = cookies.find((item) => {
    const domain = item.domain.replace(/^\./, "");
    return item.name === cookieName && (baseUrl.hostname === domain || baseUrl.hostname.endsWith(`.${domain}`));
  });
  if (!cookie) throw new Error(`B-011 未找到 ${cookieName} 会话 Cookie`);
  if (!cookie.httpOnly) throw new Error("B-011 会话 Cookie 缺少 HttpOnly");
  if (!cookie.secure) throw new Error("B-011 会话 Cookie 缺少 Secure");
  if (!['Lax', 'Strict'].includes(cookie.sameSite)) throw new Error("B-011 会话 Cookie 的 SameSite 不安全");
  return { name: cookie.name, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite };
}

export function assertHttpsHeaders(response) {
  if (!response.url.startsWith("https://")) throw new Error("B-011 应用响应不是 HTTPS");
  if (response.status < 200 || response.status >= 400) throw new Error(`B-011 应用响应状态异常：${response.status}`);
  const hsts = response.headers.get("strict-transport-security");
  if (!hsts || !/max-age=\d+/i.test(hsts)) throw new Error("B-011 HTTPS 响应缺少有效 HSTS");
  const frame = response.headers.get("x-frame-options");
  if (frame !== "DENY") throw new Error("B-011 HTTPS 响应缺少 X-Frame-Options: DENY");
  const nosniff = response.headers.get("x-content-type-options");
  if (nosniff !== "nosniff") throw new Error("B-011 HTTPS 响应缺少 X-Content-Type-Options: nosniff");
  const referrer = response.headers.get("referrer-policy");
  if (referrer !== "strict-origin-when-cross-origin") throw new Error("B-011 HTTPS 响应缺少 Referrer-Policy");
  const csp = response.headers.get("content-security-policy");
  if (!csp || !csp.includes("frame-ancestors 'none'") || !csp.includes("object-src 'none'")) throw new Error("B-011 HTTPS 响应缺少安全 CSP");
  return { hsts, frame, nosniff, referrer, csp };
}

export function assertHttpRedirect(response, baseUrl) {
  if (![301, 302, 307, 308].includes(response.status)) throw new Error(`B-011 HTTP 未跳转到 HTTPS：${response.status}`);
  const location = response.headers.get("location");
  if (!location) throw new Error("B-011 HTTP 跳转缺少 Location");
  const target = new URL(location, baseUrl);
  if (target.protocol !== "https:" || target.hostname !== baseUrl.hostname) throw new Error("B-011 HTTP 跳转目标不是同域 HTTPS");
  return { status: response.status, locationOrigin: target.origin };
}

export const stagingAuthConfirmation = CONFIRMATION;
