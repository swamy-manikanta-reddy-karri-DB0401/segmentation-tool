"use client";
import { useEffect, useMemo, useState } from "react";
import CreateDrawer from "@/components/schema/CreateDrawer";
import DetailDrawer from "@/components/schema/DetailDrawer";
import { api, CARDINALITY, Connection, Model } from "@/lib/api";

const NODE_W = 176, NODE_H = 46, GAP_Y = 24, COL_X = 300, ROW_GAP = 36;
const KIND_LABEL = { parent: "Parent Model", related: "Related Model", event: "Event" };

type Panel = { type: "create"; kind: "parent" | "related" | "event"; parent?: Model } | { type: "view"; id: number } | null;

export default function Schema() {
  const [models, setModels] = useState<Model[]>([]);
  const [sources, setSources] = useState<Connection[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [warn, setWarn] = useState<Record<number, string[]>>({});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const load = () => api<Model[]>("/api/models").then(setModels).catch((e) => setError(e.message));
  useEffect(() => { load(); api<Connection[]>("/api/connections?role=source").then(setSources); }, []);

  // layout: each parent on the left, its related models / events stacked to the right
  const layout = useMemo(() => {
    const nodes: { m: Model; x: number; y: number }[] = [];
    const edges: { from: { x: number; y: number }; to: { x: number; y: number }; m: Model }[] = [];
    let y = 20;
    for (const p of models.filter((m) => m.kind === "parent")) {
      const kids = models.filter((m) => m.parent_id === p.id);
      const h = Math.max(1, kids.length) * (NODE_H + GAP_Y) - GAP_Y;
      const py = y + h / 2 - NODE_H / 2;
      nodes.push({ m: p, x: 20, y: py });
      kids.forEach((k, i) => {
        const ky = y + i * (NODE_H + GAP_Y);
        nodes.push({ m: k, x: COL_X, y: ky });
        edges.push({ from: { x: 20 + NODE_W, y: py + NODE_H / 2 }, to: { x: COL_X, y: ky + NODE_H / 2 }, m: k });
      });
      y += h + ROW_GAP;
    }
    return { nodes, edges, height: y + 20 };
  }, [models]);

  const selected = panel?.type === "view" ? models.find((m) => m.id === panel.id) : undefined;
  const hasWarn = (id: number) => (warn[id] ?? []).length > 0;

  async function validateAll() {
    setChecking(true);
    for (const m of models) {
      try { const r = await api<{ warnings: string[] }>(`/api/models/${m.id}/validate`); setWarn((w) => ({ ...w, [m.id]: r.warnings })); } catch { /* skip */ }
    }
    setChecking(false);
  }

  const open = panel !== null;

  return (
    <div className="schema-wrap" onClick={() => setMenu(null)}>
      <div className="top">
        <h1>Schema</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))}>−</button>
          <button onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(1)))}>+</button>
          <button disabled={checking || !models.length} onClick={validateAll}>{checking ? "Validating…" : "Validate all"}</button>
          <button className="primary" onClick={() => setPanel({ type: "create", kind: "parent" })}>Create parent model</button>
        </div>
      </div>
      {error && <p className="err">{error}</p>}

      <div className="canvas">
        {!models.length && (
          <div className="empty">
            <b>Define your schema</b>
            <p className="muted">Start with a parent model (one row per audience member, e.g. Users), then add related models and events.</p>
            <button className="primary" onClick={() => setPanel({ type: "create", kind: "parent" })}>Create parent model</button>
          </div>
        )}
        <div style={{ transform: `scale(${zoom})`, transformOrigin: "0 0", position: "relative", height: layout.height, width: COL_X + NODE_W + 60 }}>
          <svg width={COL_X + NODE_W + 60} height={layout.height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {layout.edges.map(({ from, to, m }) => {
              const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
              const bad = hasWarn(m.id);
              return (
                <g key={m.id}>
                  <path d={`M${from.x},${from.y} C${mx},${from.y} ${mx},${to.y} ${to.x},${to.y}`} fill="none" stroke={bad ? "#f59e0b" : "#9ccfe0"} strokeWidth={1.5} />
                  <rect x={mx - 26} y={my - 9} width={52} height={18} rx={9} fill="#fff" stroke={bad ? "#f59e0b" : "#cfe6ee"} />
                  <text x={mx} y={my + 4} textAnchor="middle" fontSize={10} fill="#4b5b68">{CARDINALITY[m.cardinality]}{bad ? " ⚠" : ""}</text>
                </g>
              );
            })}
          </svg>
          {layout.nodes.map(({ m, x, y }) => (
            <div key={m.id} className={`node ${m.kind}` + (hasWarn(m.id) ? " warn" : "") + (selected?.id === m.id ? " sel" : "")}
              style={{ left: x, top: y, width: NODE_W, height: NODE_H }} onClick={(e) => { e.stopPropagation(); setPanel({ type: "view", id: m.id }); }}>
              <span className="ico">{m.kind === "parent" ? "◈" : m.kind === "event" ? "✦" : "◉"}</span>
              <div className="txt"><small>{KIND_LABEL[m.kind]}</small><span title={m.name}>{m.name}</span></div>
              {hasWarn(m.id) && <span className="wmark" title={warn[m.id].join("\n")}>⚠</span>}
              {m.kind === "parent" && (
                <button className="plus" title="Add related model or event" onClick={(e) => { e.stopPropagation(); setMenu(menu === m.id ? null : m.id); }}>+</button>
              )}
              {menu === m.id && (
                <div className="popover" style={{ left: NODE_W + 8, top: 0, width: 200 }} onClick={(e) => e.stopPropagation()}>
                  <div className="menu-item" onClick={() => { setMenu(null); setPanel({ type: "create", kind: "related", parent: m }); }}>Create a related model</div>
                  <div className="menu-item" onClick={() => { setMenu(null); setPanel({ type: "create", kind: "event", parent: m }); }}>Create a related event</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {open && <div className="scrim" onClick={() => setPanel(null)} />}
      {panel?.type === "create" && (
        <CreateDrawer key={`${panel.kind}-${panel.parent?.id ?? 0}`} kind={panel.kind} parent={panel.parent} sources={sources}
          onClose={() => setPanel(null)} onCreated={(m) => { setPanel({ type: "view", id: m.id }); load(); }} />
      )}
      {selected && (
        <DetailDrawer model={selected} onChanged={load} parent={models.find((p) => p.id === selected.parent_id)} warnings={warn[selected.id] ?? []}
          onClose={() => setPanel(null)} onDeleted={() => { setPanel(null); load(); }}
          onWarnings={(id, w) => setWarn((cur) => ({ ...cur, [id]: w }))} />
      )}
    </div>
  );
}
