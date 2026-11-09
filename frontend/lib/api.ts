const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100";

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body));
  return body as T;
}

export const post = <T = any>(path: string, data?: unknown) =>
  api<T>(path, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) });
export const put = <T = any>(path: string, data: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });

export type Operator = { key: string; label: string; kind: "multi" | "single" | "days" | "none"; types: string[] };
export type Column = { name: string; type: string; category: string; comment?: string; privacy?: string };
export type Condition = { type: "condition"; property: string; operator: string; values: string[]; related_id?: number; has?: boolean; event_days?: string; count_op?: string; count?: string };
export type Group = { type: "group"; op: "and" | "or"; children: (Group | Condition)[] };
export type Connection = { id: number; kind: string; role: string; name: string; config: Record<string, any> };
export type Cardinality = "has_many" | "has_one" | "many_to_one";
export const CARDINALITY: Record<string, string> = { has_many: "1:many", has_one: "1:1", many_to_one: "many:1" };
export type Model = {
  id: number; name: string; kind: "parent" | "related" | "event"; source_id: number; table_name: string;
  description: string; primary_key: string; primary_label: string; secondary_label: string; email_column: string;
  column_suggestions: boolean; parent_id: number | null; parent_key: string; related_key: string;
  extra_keys: string[][]; cardinality: Cardinality; timestamp_column: string; event_type: string;
  column_privacy: Record<string, string>;
};
export type Relation = Model & { columns: Column[] };
export type ModelSchema = { model: Model; columns: Column[]; relations: Relation[] };
export type Segment = {
  id: number; name: string; description: string; model_id: number;
  filter: Group; last_count: number | null; updated_at: string;
};
export type Run = {
  id: number; sync_id: number; status: string; trigger: string; started_at: string; finished_at: string | null;
  total: number; matched: number; added: number; removed: number; rejected: number; dry_run: boolean;
  error: string; flags: string[]; log: string;
};
export type AlertCfg = {
  on_failure: boolean; on_rejected: boolean; unhealthy_pct: number; on_stale: boolean; stale_grace_minutes: number;
  min_rows: number | null; max_rows: number | null; max_change_pct: number | null; block_on_threshold: boolean; webhook_url: string;
};
export type Schedule = { type: "manual" | "interval" | "daily"; minutes?: number; time?: string };
export type Health = { status: "healthy" | "warning" | "unhealthy" | "unknown"; reason: string };
export type Sync = {
  id: number; name: string; segment_id: number; destination_id: number; action: string; list_name: string; mode: string;
  match_key: string; match_column: string; mapping: { source: string; target: string }[]; schedule: Schedule;
  schedule_enabled: boolean; alerts: AlertCfg; timeout_minutes: number; next_run_at: string | null;
  health: Health; last_run: Run | null;
};
export type AlertRow = {
  id: number; sync_id: number; sync_name: string; run_id: number | null; kind: string; severity: string;
  message: string; created_at: string; acknowledged: boolean;
};
export type SyncOptions = {
  actions: Record<string, string>; match_keys: Record<string, string>; privacy_levels: string[];
  require_approved_fields: boolean; alert_defaults: AlertCfg;
};
export const utc = (iso: string) => new Date(iso.endsWith("Z") ? iso : iso + "Z");
