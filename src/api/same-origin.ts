export type OriginRequestLike = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
  hostname: string;
};

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerValue(headers: OriginRequestLike["headers"], name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value.find((part) => typeof part === "string" && part.length > 0) ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function isSameOriginRequest(request: OriginRequestLike, publicAppUrl?: string): boolean {
  if (!isUnsafeMethod(request.method)) return true;
  const origin = headerValue(request.headers, "origin");
  const referer = headerValue(request.headers, "referer");
  const source = origin ?? referer;
  if (!source) return true;
  const sourceOrigin = parseOrigin(source);
  if (!sourceOrigin) return false;

  const allowed = new Set<string>();
  const host = headerValue(request.headers, "host") || request.hostname;
  if (host) {
    try {
      allowed.add(new URL(`${request.protocol}://${host}`).origin);
    } catch {
      // Ignore malformed hosts; only an exact configured origin can pass.
    }
  }
  if (publicAppUrl) {
    try {
      allowed.add(new URL(publicAppUrl).origin);
    } catch {
      // Ignore malformed public URL; keep the request-host check authoritative.
    }
  }
  return allowed.has(sourceOrigin);
}
