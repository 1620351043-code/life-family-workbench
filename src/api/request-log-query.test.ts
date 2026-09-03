import { describe, expect, it } from "vitest";
import { allowedLogEntry, parseJournalLine } from "../../scripts/request_log_query.mjs";

describe("journald request log query", () => {
  it("parses pino JSON embedded in journald MESSAGE", () => {
    const journalLine = JSON.stringify({
      MESSAGE: JSON.stringify({
        time: 1788420857851,
        reqId: "trace-123",
        trace_id: "trace-123",
        method: "GET",
        route: "/healthz",
        status_code: 200,
        duration_ms: 6,
        ip_hash: "dc9a6b9d5993f63b",
        user_agent: "curl/8.5.0",
        user_id_hash: null,
        household_id_hash: null,
        email_hash: null,
        msg: "api request completed",
      }),
      _SYSTEMD_UNIT: "life-staging.service",
    });

    const entry = parseJournalLine(journalLine);
    expect(entry.trace_id).toBe("trace-123");
    expect(entry.route).toBe("/healthz");
    expect(allowedLogEntry(entry)).toEqual(
      expect.objectContaining({
        trace_id: "trace-123",
        req_id: "trace-123",
        method: "GET",
        route: "/healthz",
        status_code: 200,
      }),
    );
  });

  it("keeps plain journald metadata lines untouched", () => {
    const entry = parseJournalLine(JSON.stringify({ _SYSTEMD_UNIT: "life-staging.service", MESSAGE: "started" }));
    expect(entry.MESSAGE).toBe("started");
    expect(entry.trace_id).toBeUndefined();
  });
});
