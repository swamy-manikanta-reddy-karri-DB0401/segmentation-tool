"use client";
import { Fragment, useEffect, useState } from "react";
import SyncDrawer from "@/components/sync/SyncDrawer";
import { api, del, post, put, utc, Connection, Run, Segment, Sync, SyncOptions } from "@/lib/api";

const scheduleText = (s: Sync) =>
  s.schedule.type === "interval" ? `Every ${s.schedule.minutes! >= 60 && s.schedule.minutes! % 60 === 0 ? `${s.schedule.minutes! / 60}h` : `${s.schedule.minutes}m`}`
    : s.schedule.type === "daily" ? `Daily ${s.schedule.time} UTC` : "Manual";
const active = (r: Run | null) => !!r && ["queued", "running"].includes(r.status);
const label = (st: string) => st.replace("_", " ");

export default function Syncs() {
  const [syncs, setSyncs] = useState<Sync[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [dests, setDests] = useState<Connection[]>([]);
  const [options, setOptions] = useState<SyncOptions | null>(null);
  const [editing, setEditing] = useState<Sync | "new" | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [rejected, setRejected] = useState<Record<number, { identifier: string; reason: string }[]>>({});
  const [error, setError] = useState("");

  const load = () => api<Sync[]>("/api/syncs").then(setSyncs).catch((e) => setError(e.message));
  const loadRuns = (id: number) => api<Run[]>(`/api/syncs/${id}/runs`).then(setRuns);
  useEffect(() => {
    load();
    api<Segment[]>("/api/segments").then(setSegments);
    api<Connection[]>("/api/connections?role=destination").then(setDests);
    api<SyncOptions>("/api/meta/sync-options").then(setOptions);
  }, []);

  // poll while anything is running
  useEffect(() => {
    if (!syncs.some((s) => active(s.last_run))) return;
    const t = setTimeout(() => { load(); if (open) loadRuns(open); }, 1500);
    return () => clearTimeout(t);
  });

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setError(""); load(); if (open) loadRuns(open); } catch (e: any) { setError(e.message); }
  };
  const toggleSchedule = (s: Sync) => act(() => put(`/api/syncs/${s.id}`, { ...s, schedule_enabled: !s.schedule_enabled }));

  return (
    <>
      <div className="top">
        <h1>Syncs</h1>
        <button className="primary" disabled={!options || !segments.length || !dests.length} onClick={() => setEditing("new")}>New sync</button>
      </div>
      {error && <p className="err">{error}</p>}
      {options && (!segments.length || !dests.length) && <p className="muted">You need at least one segment and one destination connection to create a sync.</p>}

      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Name</th><th>Segment → list / action</th><th>Schedule</th><th>Health</th><th>Last run</th><th /></tr></thead>
          <tbody>
            {syncs.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td>{s.name}</td>
                  <td>
                    {segments.find((x) => x.id === s.segment_id)?.name} <span className="muted">→ {s.action === "add_to_list" ? s.list_name : options?.actions[s.action]?.split(" (")[0] ?? s.action}</span>
                  </td>
                  <td>
                    {scheduleText(s)}
                    {s.schedule.type !== "manual" && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {s.schedule_enabled ? (s.next_run_at ? `next ${utc(s.next_run_at).toLocaleString()}` : "") : "paused"}
                      </div>
                    )}
                  </td>
                  <td><span className={`badge ${s.health.status}`} title={s.health.reason}>{s.health.status}</span>
                    {s.health.reason && <div className="muted" style={{ fontSize: 12, whiteSpace: "normal", maxWidth: 220 }}>{s.health.reason}</div>}</td>
                  <td>
                    {s.last_run ? (
                      <>
                        <span className={`badge ${s.last_run.status}`}>{label(s.last_run.status)}</span>{" "}
                        <span className="muted">+{s.last_run.added} / −{s.last_run.removed} / ✕{s.last_run.rejected}{s.last_run.dry_run ? " · dry-run" : ""}</span>
                      </>
                    ) : <span className="muted">never</span>}
                  </td>
                  <td>
                    {active(s.last_run)
                      ? <button className="link danger" onClick={() => act(() => post(`/api/runs/${s.last_run!.id}/cancel`))}>Cancel</button>
                      : <button className="link" onClick={() => act(() => post(`/api/syncs/${s.id}/run`))}>Run</button>}
                    {s.schedule.type !== "manual" && <button className="link" onClick={() => toggleSchedule(s)}>{s.schedule_enabled ? "Pause" : "Resume"}</button>}
                    <button className="link" onClick={() => { if (open === s.id) setOpen(null); else { setOpen(s.id); loadRuns(s.id); } }}>History</button>
                    <button className="link" onClick={() => setEditing(s)}>Edit</button>
                    <button className="link danger" onClick={() => { if (confirm(`Delete sync "${s.name}"?`)) act(() => del(`/api/syncs/${s.id}`)); }}>Delete</button>
                  </td>
                </tr>
                {open === s.id && (
                  <tr><td colSpan={6} style={{ whiteSpace: "normal" }}>
                    {!runs.length && <span className="muted">No runs yet.</span>}
                    {runs.map((r) => (
                      <details key={r.id} style={{ marginBottom: 6 }}>
                        <summary>
                          #{r.id} <span className={`badge ${r.status}`}>{label(r.status)}</span>{" "}
                          <span className="muted">{r.trigger} · {utc(r.started_at).toLocaleString()} · matched {r.matched}, added {r.added}, removed {r.removed}, rejected {r.rejected}</span>
                          {active(r) && <button className="link danger" onClick={(e) => { e.preventDefault(); act(() => post(`/api/runs/${r.id}/cancel`)); }}>Cancel</button>}
                        </summary>
                        {r.error && <div className="warn">✕ {r.error}</div>}
                        {r.flags.map((f, i) => <div key={i} className="warn">⚠ {f}</div>)}
                        {r.rejected > 0 && (
                          <div style={{ margin: "6px 0" }}>
                            <button className="link" onClick={async () => setRejected({ ...rejected, [r.id]: await api(`/api/runs/${r.id}/rejected`) })}>View rejected rows ({r.rejected})</button>
                            {rejected[r.id] && (
                              <div className="scroll"><table>
                                <thead><tr><th>Identifier</th><th>Reason</th></tr></thead>
                                <tbody>{rejected[r.id].map((x, i) => <tr key={i}><td>{x.identifier}</td><td style={{ whiteSpace: "normal" }}>{x.reason}</td></tr>)}</tbody>
                              </table></div>
                            )}
                          </div>
                        )}
                        <pre>{r.log || "(no log)"}</pre>
                      </details>
                    ))}
                  </td></tr>
                )}
              </Fragment>
            ))}
            {!syncs.length && <tr><td colSpan={6} className="muted">No syncs yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && options && (
        <>
          <div className="scrim" onClick={() => setEditing(null)} />
          <SyncDrawer key={editing === "new" ? "new" : editing.id} sync={editing === "new" ? undefined : editing} segments={segments} dests={dests}
            options={options} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        </>
      )}
    </>
  );
}
