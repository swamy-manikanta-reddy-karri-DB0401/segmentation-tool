"use client";
import { useEffect, useState } from "react";
import { api, del, put, CARDINALITY, Column, Model } from "@/lib/api";

const LEVELS: Record<string, string> = {
  unreviewed: "Unreviewed", approved: "Approved", sync_only: "Sync only", sync_blocked: "Sync blocked", redacted: "Redacted", blocked: "Blocked",
};

type Props = { model: Model; onChanged: () => void; parent?: Model; onClose: () => void; onDeleted: () => void; onWarnings: (id: number, w: string[]) => void; warnings: string[] };

export default function DetailDrawer({ model, onChanged, parent, onClose, onDeleted, onWarnings, warnings }: Props) {
  const [tab, setTab] = useState<"overview" | "columns" | "usage">("overview");
  const [cols, setCols] = useState<Column[]>([]);
  const [usage, setUsage] = useState<{ id: number; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTab("overview"); setError("");
    api<Column[]>(`/api/models/${model.id}/columns`).then(setCols).catch((e) => setError(e.message));
    api<{ id: number; name: string }[]>(`/api/models/${model.id}/usage`).then(setUsage).catch(() => setUsage([]));
  }, [model.id]);

  async function setPrivacy(next: Record<string, string>) {
    try {
      await put(`/api/models/${model.id}/privacy`, { column_privacy: next });
      setCols(cols.map((c) => ({ ...c, privacy: next[c.name] ?? "unreviewed" })));
      onChanged();
    } catch (e: any) { setError(e.message); }
  }
  const current = () => Object.fromEntries(cols.map((c) => [c.name, c.privacy ?? "unreviewed"]));

  async function validate() {
    setBusy(true); setError("");
    try { const r = await api<{ warnings: string[] }>(`/api/models/${model.id}/validate`); onWarnings(model.id, r.warnings); }
    catch (e: any) { setError(e.message); }
    setBusy(false);
  }
  async function remove() {
    if (!confirm(`Delete "${model.name}"${model.kind === "parent" ? " and its related models" : ""}?`)) return;
    try { await del(`/api/models/${model.id}`); onDeleted(); } catch (e: any) { setError(e.message); }
  }

  const kindLabel = { parent: "Parent model", related: "Related model", event: "Event" }[model.kind];
  const row = (k: string, v: React.ReactNode) => v ? <tr><td className="muted" style={{ width: 160 }}>{k}</td><td>{v}</td></tr> : null;

  return (
    <aside className="drawer">
      <div className="drawer-head"><b>{model.name} <span className="badge">{kindLabel}</span></b><button onClick={onClose}>Exit</button></div>
      <div className="tabs" style={{ padding: "0 20px", marginBottom: 0 }}>
        {(["overview", "columns", "usage"] as const).map((t) => (
          <a key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} style={{ cursor: "pointer", textTransform: "capitalize" }}>{t}{t === "usage" ? ` (${usage.length})` : ""}</a>
        ))}
      </div>
      <div className="drawer-body">
        {error && <p className="err">{error}</p>}
        {tab === "overview" && (
          <>
            <table><tbody>
              {row("Table", model.table_name)}
              {row("Description", model.description)}
              {row("Primary key", model.primary_key)}
              {row("Primary label", model.primary_label)}
              {row("Secondary label", model.secondary_label)}
              {row("Email column", model.email_column)}
              {parent && row("Relationship", `${parent.name} ${CARDINALITY[model.cardinality]} ${model.name}`)}
              {parent && row("Join keys", [[model.parent_key, model.related_key], ...model.extra_keys].map(([p, r], i) => <div key={i}><code>{parent.name}.{p} = {model.name}.{r}</code></div>))}
              {row("Timestamp column", model.timestamp_column)}
              {row("Event type", model.event_type)}
              {row("Column suggestions", model.column_suggestions ? "On" : "Off")}
            </tbody></table>
            <div style={{ margin: "16px 0" }}>
              <button disabled={busy} onClick={validate}>{busy ? "Checking…" : "Validate data"}</button>{" "}
              <span className="muted">checks key uniqueness, join types and cardinality</span>
            </div>
            {warnings.map((w, i) => <div key={i} className="warn">⚠ {w}</div>)}
          </>
        )}
        {tab === "columns" && (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              Privacy levels control where a column can be used. <b>Approved</b>: everywhere · <b>Sync only</b>: sent to destinations, hidden from filters and previews ·
              <b> Sync blocked</b>: never sent · <b>Redacted</b>: values masked in previews · <b>Blocked</b>: hidden everywhere.
            </p>
            <button className="link" onClick={() => setPrivacy(Object.fromEntries(cols.map((c) => [c.name, c.privacy === "unreviewed" || !c.privacy ? "approved" : c.privacy])))}>
              Approve all unreviewed
            </button>
            <table>
              <thead><tr><th>Column</th><th>Type</th><th>Privacy</th><th>Description</th></tr></thead>
              <tbody>{cols.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td><td className="muted">{c.type}</td>
                  <td>
                    <select value={c.privacy ?? "unreviewed"} onChange={(e) => setPrivacy({ ...current(), [c.name]: e.target.value })}>
                      {Object.entries(LEVELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td className="muted" style={{ whiteSpace: "normal" }}>{c.comment}</td>
                </tr>
              ))}</tbody>
            </table>
          </>
        )}
        {tab === "usage" && (
          usage.length ? <ul>{usage.map((u) => <li key={u.id}><a href={`/segments/${u.id}`}>{u.name}</a></li>)}</ul>
            : <p className="muted">Not used by any segment yet.</p>
        )}
      </div>
      <div className="drawer-foot"><button className="link danger" onClick={remove}>Delete {kindLabel.toLowerCase()}</button><span /></div>
    </aside>
  );
}
