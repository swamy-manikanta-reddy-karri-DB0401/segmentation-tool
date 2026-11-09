"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, del, Model, Segment } from "@/lib/api";

export default function Segments() {
  const [items, setItems] = useState<Segment[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");
  const load = () => api<Segment[]>("/api/segments").then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); api<Model[]>("/api/models").then(setModels); }, []);

  return (
    <>
      <div className="top">
        <h1>Segments</h1>
        <Link className="btn primary" href="/segments/new">New segment</Link>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Model</th><th>Members (last saved)</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/segments/${s.id}`}>{s.name}</Link></td>
                <td className="muted">{models.find((m) => m.id === s.model_id)?.name}</td>
                <td>{s.last_count ?? "—"}</td>
                <td className="muted">{new Date(s.updated_at + "Z").toLocaleString()}</td>
                <td>
                  <button className="link danger" onClick={async () => {
                    try { await del(`/api/segments/${s.id}`); load(); } catch (e: any) { setError(e.message); }
                  }}>Delete</button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={5} className="muted">No segments yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
