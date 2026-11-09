"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const items = [
  { href: "/schema", label: "Schema" },
  { href: "/segments", label: "Segments" },
  { href: "/syncs", label: "Syncs" },
  { href: "/alerts", label: "Alerts" },
];
const connections = [
  { href: "/connections/sources", label: "Source connections" },
  { href: "/connections/destinations", label: "Destination connections" },
];

export default function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(0);
  useEffect(() => {
    const load = () => api<{ open: number }>("/api/alerts/count").then((r) => setOpen(r.open)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    window.addEventListener("alerts-changed", load);
    return () => { clearInterval(t); window.removeEventListener("alerts-changed", load); };
  }, []);
  const cls = (href: string) => "side-link" + (path === href || path.startsWith(href + "/") ? " active" : "");
  return (
    <aside className="sidebar">
      <div className="brand">Segmentation Tool</div>
      {items.map((i) => (
        <Link key={i.href} href={i.href} className={cls(i.href)}>
          {i.label}{i.href === "/alerts" && open > 0 && <span className="side-badge">{open}</span>}
        </Link>
      ))}
      <div className="side-group">Connections</div>
      {connections.map((i) => <Link key={i.href} href={i.href} className={cls(i.href) + " sub"}>{i.label}</Link>)}
    </aside>
  );
}
