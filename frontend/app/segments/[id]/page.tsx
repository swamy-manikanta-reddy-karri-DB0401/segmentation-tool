"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FilterBuilder, { emptyGroup, validate } from "@/components/FilterBuilder";
import { api, post, put, Column, Group, Model, ModelSchema, Operator, Segment } from "@/lib/api";

type Preview = { count: number; columns: string[]; rows: any[][]; labels: string[] };
const HIDDEN_IN_FILTERS = ["blocked", "sync_only"];
const filterable = (cols: Column[]) => cols.filter((c) => !HIDDEN_IN_FILTERS.includes(c.privacy ?? ""));

/** Column order for the sample table: the model's primary/secondary labels first. */
function order(p: Preview): number[] {
  const all = p.columns.map((_, i) => i);
  const first = p.labels.map((l) => p.columns.indexOf(l)).filter((i) => i >= 0);
  return [...first, ...all.filter((i) => !first.includes(i))];
}

export default function SegmentEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === "new";
  const router = useRouter();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [schema, setSchema] = useState<ModelSchema | null>(null);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState(0);
  const [filter, setFilter] = useState<Group>(emptyGroup());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Operator[]>("/api/meta/operators").then(setOperators);
    api<Model[]>("/api/models").then((all) => {
      const parents = all.filter((m) => m.kind === "parent");
      setModels(parents);
      if (isNew && parents.length) setModelId(parents[0].id);
    });
    if (!isNew) {
      api<Segment>(`/api/segments/${id}`).then((s) => {
        setName(s.name); setModelId(s.model_id);
        setFilter(s.filter?.type === "group" ? s.filter : emptyGroup());
      }).catch((e) => setError(e.message));
    }
  }, [id, isNew]);

  useEffect(() => {
    if (!modelId) return;
    api<ModelSchema>(`/api/models/${modelId}/schema`).then((s) => { setSchema(s); setError(""); }).catch((e) => setError(e.message));
  }, [modelId]);

  const valid = operators.length > 0 && validate(filter, operators);

  async function runPreview() {
    setBusy(true); setError("");
    try { setPreview(await post<Preview>("/api/segments/preview", { model_id: modelId, filter, limit: 10 })); }
    catch (e: any) { setError(e.message); setPreview(null); }
    setBusy(false);
  }

  async function save() {
    setBusy(true); setError("");
    try {
      const payload = { name, model_id: modelId, filter };
      if (isNew) await post("/api/segments", payload); else await put(`/api/segments/${id}`, payload);
      router.push("/segments");
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <>
      <div className="top">
        <h1>{isNew ? "New segment" : "Edit segment"}</h1>
        <button className="primary" disabled={busy || !valid || !name || !modelId} onClick={save}>Save segment</button>
      </div>
      {error && <p className="err">{error}</p>}

      {!models.length ? (
        <div className="card">Create a parent model first on the <Link href="/schema">Schema</Link> page.</div>
      ) : (
        <>
          <div className="card">
            <div className="form">
              <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pro users with big orders" /></div>
              <div>
                <label>Parent model</label>
                <select value={modelId} onChange={(e) => { setModelId(+e.target.value); setFilter(emptyGroup()); setPreview(null); }}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.table_name})</option>)}
                </select>
              </div>
            </div>
            {schema && schema.relations.length > 0 && (
              <p className="muted" style={{ margin: 0 }}>Related models available: {schema.relations.map((r) => r.name).join(", ")}</p>
            )}
          </div>

          <div className="card">
            <h2>Conditions</h2>
            {schema ? (
              <FilterBuilder value={filter} onChange={setFilter} columns={filterable(schema.columns)} relations={schema.relations.map((r) => ({ ...r, columns: filterable(r.columns) }))} operators={operators} parentName={schema.model.name} getValues={(rid, col) => api<string[]>(`/api/models/${rid ?? modelId}/values?column=${encodeURIComponent(col)}`)} />
            ) : <p className="muted">Loading model…</p>}
            <div style={{ marginTop: 12 }}>
              <button disabled={busy || !valid || !schema} onClick={runPreview}>Preview segment</button>
            </div>
          </div>
        </>
      )}

      {preview && (
        <div className="card">
          <h2>Preview</h2>
          <div className="count">{preview.count.toLocaleString()} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>matching rows</span></div>
          <p className="muted">Sample rows</p>
          <div className="scroll">
            <table>
              <thead><tr>{order(preview).map((j) => <th key={j}>{preview.columns[j]}</th>)}</tr></thead>
              <tbody>{preview.rows.map((r, i) => <tr key={i}>{order(preview).map((j) => <td key={j}>{r[j] === null ? <span className="muted">null</span> : String(r[j])}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
