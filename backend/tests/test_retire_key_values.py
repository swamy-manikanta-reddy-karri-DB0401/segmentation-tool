from app import config, db
from app.main import retire_key_values


def test_leftover_key_value_syncs_and_destinations_are_removed(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.sqlite3")
    ts = db.now()
    b = db.insert("brands", {"name": "CNBC", "created_at": ts})
    p = db.insert("models", {"kind": "parent", "name": "Users", "table_ref": "c.s.t", "primary_key": "id", "columns": [], "brand_id": b, "created_at": ts})
    a = db.insert("audiences", {"name": "Fans", "definition": {}, "parent_id": p, "created_at": ts, "updated_at": ts})
    kv = db.insert("destinations", {"name": "GAM key-values", "type": "gam_kv", "config": {}, "brand_id": b, "created_at": ts})
    gam = db.insert("destinations", {"name": "GAM", "type": "gam", "config": {}, "brand_id": b, "created_at": ts})
    s_kv = db.insert("syncs", {"name": "Fans → KV", "audience_id": a, "destination_id": kv, "config": {}, "created_at": ts})
    s_gam = db.insert("syncs", {"name": "Fans → GAM", "audience_id": a, "destination_id": gam, "config": {}, "created_at": ts})

    retire_key_values()

    assert [d["id"] for d in db.query("SELECT id FROM destinations")] == [gam]
    assert [s["id"] for s in db.query("SELECT id FROM syncs")] == [s_gam]
    logged = db.query("SELECT object_type, object_id, actor FROM audit_log ORDER BY id")
    assert [(r["object_type"], r["object_id"], r["actor"]) for r in logged] == [("sync", s_kv, "system"), ("destination", kv, "system")]
    retire_key_values()  # nothing left to do: safe on every start
