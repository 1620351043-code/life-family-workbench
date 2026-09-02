#!/usr/bin/env node
// I-014 staging load test driver.
// This script never prints credentials or tokens. It requires an explicit
// confirmation and refuses to target production unless the operator opts in.

const LOAD_CONFIRMATION = "I_UNDERSTAND_THIS_RUNS_LOAD_TEST";
const PRODUCTION_HOST = "life.wbutterfly.cn";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function integer(name, fallback, minimum, maximum) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

if ((process.env.LIFE_LOAD_CONFIRM ?? "") !== LOAD_CONFIRMATION) {
  throw new Error(`LIFE_LOAD_CONFIRM 必须为 ${LOAD_CONFIRMATION}`);
}

const base = new URL(required("LIFE_LOAD_BASE_URL"));
if (base.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(base.hostname)) {
  throw new Error("LIFE_LOAD_BASE_URL 必须是 HTTPS，或本机 127.0.0.1/localhost 测试地址");
}
if (base.hostname === PRODUCTION_HOST && process.env.LIFE_LOAD_ALLOW_PRODUCTION !== "YES") {
  throw new Error(`禁止直接压测生产域名 ${PRODUCTION_HOST}；确认后设置 LIFE_LOAD_ALLOW_PRODUCTION=YES`);
}

const durationSeconds = integer("LIFE_LOAD_DURATION_SECONDS", 30, 3, 600);
const concurrency = integer("LIFE_LOAD_CONCURRENCY", 8, 1, 128);
const timeoutMs = integer("LIFE_LOAD_TIMEOUT_MS", 5_000, 100, 60_000);
const maxP95Ms = integer("LIFE_LOAD_MAX_P95_MS", 2_000, 50, 60_000);
const paths = (process.env.LIFE_LOAD_PATHS ?? "/healthz").split(",").map((item) => item.trim()).filter(Boolean);
if (!paths.length) throw new Error("LIFE_LOAD_PATHS 不能为空");

const email = process.env.LIFE_LOAD_EMAIL ?? "";
const password = process.env.LIFE_LOAD_PASSWORD ?? "";
let cookie = "";
if (email || password) {
  if (!email || !password) throw new Error("LIFE_LOAD_EMAIL 与 LIFE_LOAD_PASSWORD 必须同时提供");
  const login = await fetch(new URL("/api/auth/login", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!login.ok) throw new Error(`登录失败：HTTP ${login.status}`);
  const setCookie = login.headers.get("set-cookie");
  cookie = setCookie?.split(";")[0] ?? "";
}

const headers = cookie ? { cookie } : {};
const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1_000;
const latencies = [];
const statusCounts = new Map();
let successes = 0;
let clientErrors = 0;
let serverErrors = 0;
let networkErrors = 0;
let cursor = 0;

async function runWorker() {
  while (Date.now() < deadline) {
    const path = paths[cursor % paths.length];
    cursor += 1;
    const requestStarted = Date.now();
    try {
      const response = await fetch(new URL(path, base), {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const elapsed = Date.now() - requestStarted;
      const bucket = response.status >= 500 ? "server" : response.status >= 400 ? "client" : "success";
      statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1);
      if (bucket === "success") successes += 1;
      else if (bucket === "client") clientErrors += 1;
      else serverErrors += 1;
      latencies.push(elapsed);
    } catch {
      networkErrors += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
latencies.sort((left, right) => left - right);
const total = successes + clientErrors + serverErrors + networkErrors;
const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : 0;
const maxMs = latencies.length ? latencies[latencies.length - 1] : 0;
const averageMs = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;
const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1_000);
const allowedServerErrors = Math.max(1, Math.floor(total * 0.01));
const ok = total > 0 && p95 <= maxP95Ms && serverErrors <= allowedServerErrors && networkErrors <= Math.max(1, Math.floor(total * 0.02));
const report = {
  ok,
  base_url: base.hostname,
  protocol: base.protocol,
  duration_seconds: durationSeconds,
  concurrency,
  paths,
  total_requests: total,
  success_requests: successes,
  client_error_requests: clientErrors,
  server_error_requests: serverErrors,
  network_errors: networkErrors,
  requests_per_second: Number((total / elapsedSeconds).toFixed(2)),
  latencies_ms: { average: Math.round(averageMs), p50, p95, max: maxMs },
  status_counts: Object.fromEntries(statusCounts),
  authenticated_requests: Boolean(cookie),
};
console.log(JSON.stringify(report, null, 2));
if (!ok) {
  process.exitCode = 1;
}
