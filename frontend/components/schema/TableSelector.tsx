"use client";
import { useEffect, useMemo, useState } from "react";
import { api, post, Connection } from "@/lib/api";

type Props = {
  sources: Connection[];
  sourceId: number;
  table: string;
  lockSource?: boolean;
  onChange: (v: { sourceId: number; table: string }) => void;
};
type PreviewData = { columns: string[]; rows: any[][]; count: number | null };

/** Step 1 of the model wizard: pick a table, search, refresh, and preview results. */
export default function TableSelector({ sources, sourceId, table, lockSource, onChange }: Props) {
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [catalog, setCatalog] = useState("");
  const [tables, setTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [gear, setGear] = useState(false);
  const [limit100, setLimit100] = useState(true);
  const [showCount, setShowCount] = useState(true);

  useEffect(() => {
    if (!sourceId) return;
    api<string[]>(`/api/connections/${sourceId}/catalogs`)
      .then((c) => {
        setCatalogs(c);
        const fromTable = table.split(".")[0];
        setCatalog((cur) => (c.includes(cur) ? cur : c.includes(fromTable) ? fromTable : c.includes("samples") ? "samples" : c[0] ?? ""));
      })
      .catch((e) => setError(e.message));
  }, [sourceId]);

  const loadTables = () => {
    if (!sourceId || !catalog) return;
    setLoading(true); setError("");
    api<string[]>(`/api/connections/${sourceId}/tables?catalog=${encodeURIComponent(catalog)}`)
      .then(setTables).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(loadTables, [sourceId, catalog]);
  useEffect(() => setPreview(null), [table, sourceId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? tables.filter((t) => t.toLowerCase().includes(q)) : tables;
  }, [tables, search]);

  async function runPreview() {
    setPreviewing(true); setError("");
    try {
      setPreview(await post<PreviewData>(`/api/connections/${sourceId}/preview-table`, { table, limit: limit100 ? 100 : 1000, count: showCount }));
    } catch (e: any) { setError(e.message); setPreview(null); }
    setPreviewing(false);
  }

  return (
    <div>
      <div className="form" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div>
          <label>Source</label>
          <select value={sourceId} disabled={lockSource} onChange={(e) => onChange({ sourceId: +e.target.value, table: "" })}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label>Catalog</label>
          <select value={catalog} onChange={(e) => { setCatalog(e.target.value); onChange({ sourceId, table: "" }); }}>
            {catalogs.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="tbl-box">
        <div className="tbl-head">
          <b>{sources.find((s) => s.id === sourceId)?.name}</b>
          <input placeholder="Search tables…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, maxWidth: 280 }} />
          <button title="Refresh table list" onClick={loadTables} disabled={loading}>{loading ? "…" : "⟳"}</button>
        </div>
        <div className="tbl-list">
          {filtered.map((t) => (
            <div key={t} className={"tbl-item" + (t === table ? " selected" : "")} onClick={() => onChange({ sourceId, table: t })}>
              ▦ {t}
            </div>
          ))}
          {!filtered.length && <div className="muted" style={{ padding: 12 }}>{loading ? "Loading tables…" : "No tables found."}</div>}
        </div>
      </div>
      {error && <p className="err">{error}</p>}

      <div style={{ margin: "12px 0", position: "relative", display: "flex", gap: 8 }}>
        <button disabled={!table || previewing} onClick={runPreview}>{previewing ? "Running…" : "Preview results"}</button>
        <button title="Preview settings" onClick={() => setGear(!gear)}>⚙</button>
        {gear && (
          <div className="popover" style={{ top: 38, left: 130 }}>
            <label className="check"><input type="checkbox" checked={limit100} onChange={(e) => setLimit100(e.target.checked)} /> Limit preview to 100 rows</label>
            <label className="check"><input type="checkbox" checked={showCount} onChange={(e) => setShowCount(e.target.checked)} /> Show row count</label>
          </div>
        )}
      </div>

      <div className="card" style={{ minHeight: 160 }}>
        {preview ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              {preview.count !== null && <>{preview.count.toLocaleString()} rows · </>}showing {preview.rows.length}
            </p>
            <div className="scroll">
              <table>
                <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{preview.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j}>{v === null ? <span className="muted">null</span> : String(v).slice(0, 60)}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          </>
        ) : (
          <div style={{ textAlign: "center", padding: 24 }}>
            <b>Ready to test your query?</b>
            <div className="muted">Preview your table to see the resulting rows</div>
          </div>
        )}
      </div>
    </div>
  );
}
