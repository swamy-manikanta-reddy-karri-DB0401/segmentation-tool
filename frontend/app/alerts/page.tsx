"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, post, utc, AlertRow } from "@/lib/api";

const KIND: Record<string, string> = {
  failed: "Sync failed", rejected: "Rows rejected", cancelled: "Run cancelled", timed_out: "Run timed out",
  stale: "Sync stale", threshold: "Row-count threshold",
};

export default function Alerts() {
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState("");
  const load = () => api<AlertRow[]>(`/api/alerts?open_only=${openOnly}`).then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [openOnly]);
  const act = async (fn: () => Promise<unknown>) => { await fn(); load(); window.dispatchEvent(new Event("alerts-changed")); };

  return (
    <>
      <div className="top">
        <h1>Alerts</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only</label>
          <button disabled={!rows.some((r) => !r.acknowledged)} onClick={() => act(() => post("/api/alerts/ack-all"))}>Acknowledge all</button>
        </div>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>When</th><th>Severity</th><th>Type</th><th>Sync</th><th>Details</th><th /></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} style={{ opacity: a.acknowledged ? 0.55 : 1 }}>
                <td className="muted">{utc(a.created_at).toLocaleString()}</td>
                <td><span className={`badge ${a.severity}`}>{a.severity}</span></td>
                <td>{KIND[a.kind] ?? a.kind}</td>
                <td><Link href="/syncs">{a.sync_name}</Link></td>
                <td style={{ whiteSpace: "normal" }}>{a.message}</td>
                <td>{!a.acknowledged && <button className="link" onClick={() => act(() => post(`/api/alerts/${a.id}/ack`))}>Acknowledge</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted">{openOnly ? "No open alerts. 🎉" : "No alerts yet."}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
