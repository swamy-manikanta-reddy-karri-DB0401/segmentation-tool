"use client";
import { useEffect, useMemo, useState } from "react";
import { api, post, put, AlertCfg, Column, Connection, ModelSchema, Schedule, Segment, Sync, SyncOptions } from "@/lib/api";

type Props = {
  sync?: Sync; segments: Segment[]; dests: Connection[]; options: SyncOptions;
  onClose: () => void; onSaved: () => void;
};

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

export default function SyncDrawer({ sync, segments, dests, options, onClose, onSaved }: Props) {
  const [name, setName] = useState(sync?.name ?? "");
  const [segmentId, setSegmentId] = useState(sync?.segment_id ?? segments[0]?.id ?? 0);
  const [destId, setDestId] = useState(sync?.destination_id ?? dests[0]?.id ?? 0);
  const [action, setAction] = useState(sync?.action ?? "add_to_list");
  const [listName, setListName] = useState(sync?.list_name ?? "");
  const [mode, setMode] = useState(sync?.mode ?? "mirror");
  const [matchKey, setMatchKey] = useState(sync?.match_key ?? "email");
  const [matchColumn, setMatchColumn] = useState(sync?.match_column ?? "");
  const [mapping, setMapping] = useState(sync?.mapping ?? []);
  const [sched, setSched] = useState<Schedule>(sync?.schedule ?? { type: "manual" });
  const [enabled, setEnabled] = useState(sync?.schedule_enabled ?? true);
  const [alerts, setAlerts] = useState<AlertCfg>(sync?.alerts ?? options.alert_defaults);
  const [timeout, setTimeoutMin] = useState(sync?.timeout_minutes ?? 30);
  const [schema, setSchema] = useState<ModelSchema | null>(null);
  const [lists, setLists] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const seg = segments.find((s) => s.id === segmentId);
  useEffect(() => {
    if (!seg) return;
    api<ModelSchema>(`/api/models/${seg.model_id}/schema`).then(setSchema).catch((e) => setError(e.message));
  }, [seg?.model_id]);
  useEffect(() => {
    if (!destId) return;
    api<{ name: string }[]>(`/api/connections/${destId}/lists`).then((l) => setLists(l.map((x) => x.name))).catch(() => setLists([]));
  }, [destId]);

  const cols = schema?.columns ?? [];
  const identCol = matchColumn || (matchKey === "email" ? schema?.model.email_column ?? "" : "");

  const blocked = (c: Column) =>
    c.privacy === "blocked" || c.privacy === "sync_blocked" || (c.privacy === "unreviewed" && options.require_approved_fields);
  const why = (c: Column) => (c.privacy === "unreviewed" ? "unreviewed" : (c.privacy ?? "").replace("_", "-"));
  const colLabel = (c: Column) => (blocked(c) ? `${c.name} — ${why(c)}` : c.name);

  const setA = <K extends keyof AlertCfg>(k: K, v: AlertCfg[K]) => setAlerts({ ...alerts, [k]: v });
  const showList = action === "add_to_list";

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!identCol) p.push("Choose the column that holds the identifier");
    if (showList && !listName.trim()) p.push("Enter the Sailthru list name");
    return p;
  }, [identCol, showList, listName]);

  async function save() {
    setBusy(true); setError("");
    const body = {
      name, segment_id: segmentId, destination_id: destId, action, list_name: showList ? listName : "", mode,
      match_key: matchKey, match_column: matchColumn, mapping: mapping.filter((m) => m.source && m.target),
      schedule: sched, schedule_enabled: enabled, alerts, timeout_minutes: timeout,
    };
    try {
      if (sync) await put(`/api/syncs/${sync.id}`, body); else await post("/api/syncs", body);
      onSaved();
    } catch (e: any) { setError(e.message); setBusy(false); }
  }

  return (
    <aside className="drawer">
      <div className="drawer-head"><b>{sync ? "Edit sync" : "New sync"}</b><button onClick={onClose}>Exit</button></div>
      <div className="drawer-body">
        <div className="stack">
          <div className="grid2">
            <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><label>Segment</label>
              <select value={segmentId} onChange={(e) => { setSegmentId(+e.target.value); setMapping([]); setMatchColumn(""); }}>
                {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></div>
            <div><label>Destination</label>
              <select value={destId} onChange={(e) => setDestId(+e.target.value)}>{dests.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
          </div>

          <div className="section">
            <h3>Sync action</h3>
            <div className="stack" style={{ gap: 8 }}>
              {Object.entries(options.actions).map(([k, v]) => (
                <label key={k} className="check" style={{ margin: 0 }}>
                  <input type="radio" name="action" checked={action === k} onChange={() => setAction(k)} /> {v}
                </label>
              ))}
            </div>
            {showList && (
              <div className="grid2" style={{ marginTop: 10 }}>
                <div><label>Sailthru list</label>
                  <input list="sailthru-lists" value={listName} onChange={(e) => setListName(e.target.value)} placeholder="list name" />
                  <datalist id="sailthru-lists">{lists.map((l) => <option key={l} value={l} />)}</datalist></div>
                <div><label>List behaviour</label>
                  <select value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="mirror">Mirror (add and remove)</option>
                    <option value="upsert">Add only (never remove)</option>
                  </select></div>
              </div>
            )}
            {action === "set_vars" && <p className="hint">Looks up each profile first and rejects the ones that don&apos;t exist (one extra API call per user).</p>}
          </div>

          <div className="section">
            <h3>Matching key</h3>
            <div className="grid2">
              <div><label>Sailthru key</label>
                <select value={matchKey} onChange={(e) => setMatchKey(e.target.value)}>
                  {Object.entries(options.match_keys).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <div><label>Source column with the identifier</label>
                <select value={matchColumn} onChange={(e) => setMatchColumn(e.target.value)}>
                  <option value="">{matchKey === "email" && schema?.model.email_column ? `${schema.model.email_column} (model email column)` : "Select a column…"}</option>
                  {cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select></div>
            </div>
            <p className="hint">Rows with a blank identifier are skipped. Email values are lower-cased before matching.</p>
          </div>

          <div className="section">
            <h3>Field mapping → Sailthru vars</h3>
            {options.require_approved_fields && <p className="hint" style={{ marginTop: 0 }}>Only columns with privacy level <b>Approved</b> (or sync-only / redacted) can be sent. Change levels on the Schema page → Columns.</p>}
            {mapping.map((m, i) => (
              <div key={i} className="cond" style={{ marginBottom: 6 }}>
                <select value={m.source} onChange={(e) => setMapping(mapping.map((x, j) => (j === i ? { source: e.target.value, target: x.target || e.target.value } : x)))}>
                  <option value="">column…</option>
                  {cols.map((c) => <option key={c.name} value={c.name} disabled={blocked(c)}>{colLabel(c)}</option>)}
                </select>
                →
                <input value={m.target} onChange={(e) => setMapping(mapping.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} placeholder="sailthru var" />
                <button className="icon" onClick={() => setMapping(mapping.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button className="link" onClick={() => setMapping([...mapping, { source: "", target: "" }])}>+ Add mapping</button>
          </div>

          <div className="section">
            <h3>Schedule</h3>
            <div className="cond">
              <select value={sched.type} onChange={(e) => setSched(e.target.value === "interval" ? { type: "interval", minutes: 60 } : e.target.value === "daily" ? { type: "daily", time: "09:00" } : { type: "manual" })}>
                <option value="manual">Manual only</option>
                <option value="interval">Every…</option>
                <option value="daily">Daily at…</option>
              </select>
              {sched.type === "interval" && (
                <>
                  <input type="number" min={5} style={{ width: 90 }} value={sched.minutes ?? 60} onChange={(e) => setSched({ type: "interval", minutes: +e.target.value })} />
                  <span className="muted">minutes (min 5)</span>
                  {[15, 60, 360, 1440].map((m) => <button key={m} className={"chip-btn" + (sched.minutes === m ? " on" : "")} onClick={() => setSched({ type: "interval", minutes: m })}>{m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : "24h"}</button>)}
                </>
              )}
              {sched.type === "daily" && (
                <>
                  <input type="time" value={sched.time ?? "09:00"} onChange={(e) => setSched({ type: "daily", time: e.target.value })} />
                  <span className="muted">UTC</span>
                </>
              )}
            </div>
            {sched.type !== "manual" && (
              <label className="check" style={{ margin: "10px 0 0" }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Schedule enabled</label>
            )}
          </div>

          <div className="section">
            <h3>Alerts &amp; health</h3>
            <div className="stack" style={{ gap: 8 }}>
              <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={alerts.on_failure} onChange={(e) => setA("on_failure", e.target.checked)} /> Alert when a run fails, is cancelled or times out (unhealthy)</label>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={alerts.on_rejected} onChange={(e) => setA("on_rejected", e.target.checked)} /> Alert when rows are rejected (warning; unhealthy at
                <input type="number" min={1} max={100} style={{ width: 64 }} value={alerts.unhealthy_pct} onChange={(e) => setA("unhealthy_pct", +e.target.value)} /> % rejected)
              </label>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={alerts.on_stale} onChange={(e) => setA("on_stale", e.target.checked)} /> Alert when a scheduled sync is stale (grace
                <input type="number" min={0} style={{ width: 64 }} value={alerts.stale_grace_minutes} onChange={(e) => setA("stale_grace_minutes", +e.target.value)} /> min)
              </label>
              <div className="grid2">
                <div><label>Minimum rows</label><input type="number" min={0} value={alerts.min_rows ?? ""} onChange={(e) => setA("min_rows", numOrNull(e.target.value))} placeholder="no limit" /></div>
                <div><label>Maximum rows</label><input type="number" min={0} value={alerts.max_rows ?? ""} onChange={(e) => setA("max_rows", numOrNull(e.target.value))} placeholder="no limit" /></div>
                <div><label>Max change vs last run (%)</label><input type="number" min={0} value={alerts.max_change_pct ?? ""} onChange={(e) => setA("max_change_pct", numOrNull(e.target.value))} placeholder="no limit" /></div>
                <div><label>Run timeout (minutes)</label><input type="number" min={1} max={240} value={timeout} onChange={(e) => setTimeoutMin(+e.target.value)} /></div>
              </div>
              <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={alerts.block_on_threshold} onChange={(e) => setA("block_on_threshold", e.target.checked)} /> Stop the run (push nothing) when a row-count limit is violated</label>
              <div><label>Webhook URL (optional, Slack-compatible)</label><input value={alerts.webhook_url} onChange={(e) => setA("webhook_url", e.target.value)} placeholder="https://hooks.slack.com/…" /></div>
            </div>
          </div>
        </div>
        {error && <p className="err">{error}</p>}
      </div>
      <div className="drawer-foot">
        <span className="err">{problems[0]}</span>
        <button className="primary" disabled={busy || !name.trim() || !segmentId || !destId || problems.length > 0} onClick={save}>{sync ? "Save changes" : "Create sync"}</button>
      </div>
    </aside>
  );
}
