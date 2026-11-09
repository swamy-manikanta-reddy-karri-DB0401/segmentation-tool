"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, del, post, Connection } from "@/lib/api";

export default function ConnectionsView({ role }: { role: "source" | "destination" }) {
  const kind = role === "source" ? "databricks" : "sailthru";
  const [items, setItems] = useState<Connection[]>([]);
  const [msgs, setMsgs] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [error, setError] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [dry, setDry] = useState(true);
  const load = () => api<Connection[]>(`/api/connections?role=${role}`).then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [role]);

  const fields = kind === "databricks"
    ? ["server_hostname", "http_path", "access_token", "catalog", "schema"]
    : ["api_key", "api_secret"];

  async function add() {
    try {
      const config: Record<string, any> = { ...f };
      delete config.name;
      if (kind === "sailthru") config.dry_run = dry;
      await post("/api/connections", { kind, name: f.name || kind, config });
      setF({}); setError(""); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <>
      <h1>Connections</h1>
      <div className="tabs">
        <Link href="/connections/sources" className={role === "source" ? "active" : ""}>Source connections</Link>
        <Link href="/connections/destinations" className={role === "destination" ? "active" : ""}>Destination connections</Link>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Type</th><th /></tr></thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.kind}{c.config.dry_run ? " (dry-run)" : ""}</td>
                <td>
                  <button className="link" onClick={async () => setMsgs({ ...msgs, [c.id]: await post(`/api/connections/${c.id}/test`) })}>Test</button>
                  {c.kind !== "demo" && !c.config.from_env && (
                    <button className="link danger" onClick={async () => { try { await del(`/api/connections/${c.id}`); load(); } catch (e: any) { setError(e.message); } }}>Delete</button>
                  )}
                  {msgs[c.id] && <span className={msgs[c.id].ok ? "ok" : "err"}> {msgs[c.id].message}</span>}
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={3} className="muted">No {role} connections yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Add {kind === "databricks" ? "Databricks source" : "Sailthru destination"}</h2>
        <div className="form">
          <div><label>Name</label><input value={f.name || ""} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          {fields.map((k) => (
            <div key={k}>
              <label>{k}</label>
              <input type={k.includes("secret") || k.includes("token") ? "password" : "text"} value={f[k] || ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        {kind === "sailthru" && (
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} style={{ width: "auto" }} /> Dry-run (log payloads, don&apos;t call Sailthru)
          </label>
        )}
        <button className="primary" onClick={add}>Add</button>
      </div>
    </>
  );
}
