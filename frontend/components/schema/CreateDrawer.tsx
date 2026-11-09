"use client";
import { useEffect, useState } from "react";
import TableSelector from "./TableSelector";
import { api, post, CARDINALITY, Column, Connection, Model } from "@/lib/api";

type Props = {
  kind: "parent" | "related" | "event";
  parent?: Model;
  sources: Connection[];
  onClose: () => void;
  onCreated: (m: Model) => void;
};

const TITLES = { parent: "New parent model", related: "New related model", event: "New event" };
const EVENT_TYPES = ["Generic", "Page view", "Purchase", "Sign up", "Custom"];

export default function CreateDrawer({ kind, parent, sources, onClose, onCreated }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [sourceId, setSourceId] = useState(parent?.source_id ?? sources[0]?.id ?? 0);
  const [table, setTable] = useState("");
  const [cols, setCols] = useState<Column[]>([]);
  const [parentCols, setParentCols] = useState<Column[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [suggest, setSuggest] = useState(true);
  const [pk, setPk] = useState("");
  const [primaryLabel, setPrimaryLabel] = useState("");
  const [secondaryLabel, setSecondaryLabel] = useState("");
  const [email, setEmail] = useState("");
  const [card, setCard] = useState<string>("has_many");
  const [parentKey, setParentKey] = useState("");
  const [relatedKey, setRelatedKey] = useState("");
  const [multi, setMulti] = useState(false);
  const [extra, setExtra] = useState<string[][]>([]);
  const [tsCol, setTsCol] = useState("");
  const [eventType, setEventType] = useState("Generic");

  useEffect(() => { if (!sourceId && sources.length) setSourceId(sources[0].id); }, [sources, sourceId]);
  useEffect(() => {
    if (!parent) return;
    api<Column[]>(`/api/models/${parent.id}/columns`).then((c) => { setParentCols(c); setParentKey(parent.primary_key); });
  }, [parent]);

  // entering step 2: load columns and pick sensible defaults
  async function toConfig() {
    setError("");
    try {
      const c = await api<Column[]>(`/api/connections/${sourceId}/columns?table=${encodeURIComponent(table)}`);
      setCols(c);
      const find = (re: RegExp) => c.find((x) => re.test(x.name))?.name ?? "";
      if (kind === "parent") {
        setPk(find(/^(id|.*_id)$/i) || c[0]?.name || "");
        setEmail(find(/email/i));
        setPrimaryLabel(find(/email|name/i));
      } else {
        setRelatedKey((parent && c.find((x) => x.name === parent.primary_key)?.name) || find(/user_id|customer_id|.*_id$/i) || c[0]?.name || "");
        if (kind === "event") setTsCol(find(/(_at|time|date)/i));
      }
      setStep(2);
    } catch (e: any) { setError(e.message); }
  }

  async function create() {
    setBusy(true); setError("");
    try {
      const m = await post<Model>("/api/models", {
        name, kind, source_id: sourceId, table_name: table, description, column_suggestions: suggest,
        primary_key: pk, primary_label: primaryLabel, secondary_label: secondaryLabel, email_column: kind === "parent" ? email : "",
        parent_id: parent?.id ?? null, cardinality: card, parent_key: parentKey, related_key: relatedKey,
        extra_keys: multi ? extra.filter((p) => p[0] && p[1]) : [], timestamp_column: tsCol, event_type: kind === "event" ? eventType : "",
      });
      onCreated(m);
    } catch (e: any) { setError(e.message); setBusy(false); }
  }

  const colOpts = (list: Column[], empty?: string) => (
    <>{empty !== undefined && <option value="">{empty}</option>}{list.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</>
  );
  const ready = name.trim() && (kind === "parent" ? pk : parentKey && relatedKey && (kind !== "event" || tsCol));

  return (
    <aside className="drawer">
      <div className="drawer-head"><b>{TITLES[kind]}{parent && <span className="muted"> · {parent.name}</span>}</b><button onClick={onClose}>Exit</button></div>
      <div className="steps">
        <span className={"step" + (step === 1 ? " on" : "")}><i>1</i> Select table</span>
        <span className={"step" + (step === 2 ? " on" : "")}><i>2</i> Configuration</span>
      </div>

      <div className="drawer-body">
        {step === 1 ? (
          <TableSelector sources={sources} sourceId={sourceId} table={table} lockSource={!!parent} onChange={(v) => { setSourceId(v.sourceId); setTable(v.table); }} />
        ) : (
          <div className="stack">
            <Field label="Name" hint={`Something simple like "${kind === "parent" ? "Users" : kind === "event" ? "Product Viewed" : "Purchases"}"`}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter a name…" />
            </Field>
            <Field label="Description (optional)"><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Enter a description…" /></Field>

            {kind === "event" && (
              <>
                <Field label="Timestamp column" hint="When the event happened (e.g. occurred_at)"><select value={tsCol} onChange={(e) => setTsCol(e.target.value)}>{colOpts(cols, "Select a column…")}</select></Field>
                <Field label="Event type"><select value={eventType} onChange={(e) => setEventType(e.target.value)}>{EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
              </>
            )}

            {kind !== "parent" && parent && (
              <>
                <Field label="Relationship" hint={`How ${parent.name} relates to this table`}>
                  <select value={card} onChange={(e) => setCard(e.target.value)}>
                    {Object.entries(CARDINALITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <Field label="Foreign key (join key)" hint="Columns that connect the two tables">
                  <div className="cond">
                    <select value={parentKey} onChange={(e) => setParentKey(e.target.value)}>{colOpts(parentCols)}</select>
                    <span className="muted">{parent.name} =</span>
                    <select value={relatedKey} onChange={(e) => setRelatedKey(e.target.value)}>{colOpts(cols)}</select>
                  </div>
                  {multi && extra.map((p, i) => (
                    <div className="cond" key={i} style={{ marginTop: 6 }}>
                      <select value={p[0]} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))}>{colOpts(parentCols, "Select…")}</select>
                      <span className="muted">=</span>
                      <select value={p[1]} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}>{colOpts(cols, "Select…")}</select>
                      <button className="icon" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                  <label className="check" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={multi} onChange={(e) => { setMulti(e.target.checked); if (e.target.checked && !extra.length) setExtra([["", ""]]); }} /> Multiple join keys
                  </label>
                  {multi && <button className="link" onClick={() => setExtra([...extra, ["", ""]])}>+ Add join key</button>}
                </Field>
              </>
            )}

            <label className="toggle">
              <input type="checkbox" checked={suggest} onChange={(e) => setSuggest(e.target.checked)} />
              <span>
                <b>Column suggestions</b><br />
                <span className="muted">Suggestions will cache common column values for selection when building an audience.</span>
              </span>
            </label>

            <Field label={kind === "parent" ? "Primary key" : "Primary key (optional)"} hint={`Key that is unique and consistent across queries. E.g. "id" or "email"`}>
              <select value={pk} onChange={(e) => setPk(e.target.value)}>{colOpts(cols, "Select a column…")}</select>
            </Field>
            {kind === "parent" && (
              <>
                <Field label="Primary label" hint={`Used when previewing results from an audience. E.g. "full_name"`}><select value={primaryLabel} onChange={(e) => setPrimaryLabel(e.target.value)}>{colOpts(cols, "Select a column…")}</select></Field>
                <Field label="Secondary label" hint={`Used when previewing results from an audience. E.g. "email"`}><select value={secondaryLabel} onChange={(e) => setSecondaryLabel(e.target.value)}>{colOpts(cols, "Select a column…")}</select></Field>
                <Field label="Email column" hint="Needed to sync members to Sailthru"><select value={email} onChange={(e) => setEmail(e.target.value)}>{colOpts(cols, "— none —")}</select></Field>
              </>
            )}
          </div>
        )}
        {error && <p className="err">{error}</p>}
      </div>

      <div className="drawer-foot">
        {step === 1 ? (
          <><span /><button className="primary" disabled={!table} onClick={toConfig}>Continue →</button></>
        ) : (
          <>
            <button onClick={() => setStep(1)}>← Go back</button>
            <button className="primary" disabled={!ready || busy} onClick={create}>
              {kind === "parent" ? "Create parent model" : kind === "event" ? "Create event" : "Create related model"}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
