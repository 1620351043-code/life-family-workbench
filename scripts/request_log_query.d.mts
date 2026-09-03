export type JournalLogEntry = Record<string, unknown> & {
  MESSAGE?: string;
  trace_id?: string;
  reqId?: string;
  time?: number;
  method?: string;
  route?: string;
  status_code?: number;
  duration_ms?: number;
  error_code?: string;
  msg?: string;
};

export type AllowedLogEntry = {
  time: number | null;
  trace_id: string | null;
  req_id: string | null;
  method: string | null;
  route: string | null;
  status_code: number | null;
  duration_ms: number | null;
  error_code: string | null;
  msg: string | null;
};

export function parseJournalLine(line: string): JournalLogEntry;
export function allowedLogEntry(entry: JournalLogEntry): AllowedLogEntry;
