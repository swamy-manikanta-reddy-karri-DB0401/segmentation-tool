"""Audience operations against Databricks: size, per-condition counts, overlap,
breakdowns, previews and trait previews."""
from __future__ import annotations

from . import connection, db
from .catalog import quote_column
from .compiler import Compiled, Compiler, CompileError, column_setting, source
from .databricks import client

HIDDEN_IN_PREVIEW = {"redacted", "blocked", "sync_only"}


def parents() -> list[dict]:
    return db.query("SELECT * FROM models WHERE kind = 'parent' ORDER BY id")


def default_parent_id() -> int | None:
    p = db.one("SELECT id FROM models WHERE kind = 'parent' ORDER BY id LIMIT 1")
    return p["id"] if p else None


def load_schema(parent_id: int | None = None) -> dict:
    parent_id = parent_id or default_parent_id()
    parent = db.one("SELECT * FROM models WHERE id = ? AND kind = 'parent'", (parent_id,)) if parent_id else None
    models = db.query("SELECT * FROM models WHERE parent_id = ? ORDER BY id", (parent_id,)) if parent else []
    traits = db.query("SELECT * FROM traits WHERE parent_id = ? ORDER BY id", (parent_id,)) if parent else []
    return {"parent": parent, "models": {m["id"]: m for m in models}, "traits": {t["id"]: t for t in traits}}


def as_of(parent_id: int | None = None) -> str | None:
    """Analysis date: a parent model's own setting wins over the workspace default.
    A parent-level "" means "use today" for that parent."""
    pid = parent_id or default_parent_id()
    per_parent = db.get_setting("parent_as_of_date", {}) or {}
    if pid is not None and str(pid) in per_parent:
        return per_parent[str(pid)] or None
    return db.get_setting("as_of_date") or None


def null_matches_negation() -> bool:
    """Workspace setting: do null values match negative operators such as 'does not equal'?
    "value" = treat null values like any other value (they match); "special" = they don't."""
    return db.get_setting("null_behavior", "value") == "value"


def _load_audience(audience_id: int) -> dict:
    a = db.one("SELECT definition FROM audiences WHERE id = ?", (audience_id,))
    if not a:
        raise CompileError(f"Audience {audience_id} not found")
    return a["definition"]


def compiler(parent_id: int | None = None) -> Compiler:
    schema = load_schema(parent_id)
    pid = schema["parent"]["id"] if schema["parent"] else None
    connection.use_parent(pid)
    return Compiler(schema, as_of(pid), _load_audience, null_matches_negation=null_matches_negation())


def compile_definition(definition: dict, select: str | None = None, from_: str | None = None,
                       parent_id: int | None = None) -> Compiled:
    return compiler(parent_id).compile(definition, select, from_)


def _empty(definition):
    return definition or {"type": "group", "op": "and", "conditions": []}


def size(definition: dict, parent_id: int | None = None) -> int:
    c = compile_definition(definition, select="1", parent_id=parent_id)
    return client().execute(f"SELECT COUNT(*) FROM (\n{c.sql}\n)", c.params).rows[0][0]


def calculate(definition: dict, parent_id: int | None = None) -> dict:
    """Total customers, audience size and — for AND audiences — the cumulative size after
    each top-level condition, in one warehouse query."""
    definition = _empty(definition)
    if definition.get("op", "and") == "and":
        c = compiler(parent_id).funnel(definition)
        row = client().execute(c.sql, c.params).rows[0]
        steps = list(row[1:])
        return {"total": row[0], "size": steps[-1] if steps else row[0], "steps": steps}
    comp = compiler(parent_id)
    c = comp.wrap(f"SELECT COUNT(*), COUNT_IF({comp.node(definition)}) FROM {comp.parent_from()}")
    total, n = client().execute(c.sql, c.params).rows[0]
    return {"total": total, "size": n, "steps": []}


def overlap(definition: dict, other_audience_id: int, parent_id: int | None = None) -> dict:
    other = db.one("SELECT name, definition, parent_id FROM audiences WHERE id = ?", (other_audience_id,))
    if not other:
        raise CompileError("Audience not found")
    if parent_id and other["parent_id"] and other["parent_id"] != parent_id:
        raise CompileError("Overlap needs audiences built on the same parent model")
    comp = compiler(parent_id)
    a, b = comp.node(_empty(definition)), comp.node(other["definition"])
    c = comp.wrap(f"SELECT COUNT_IF({a}), COUNT_IF({b}), COUNT_IF(({a}) AND ({b})), COUNT(*) FROM {comp.parent_from()}")
    this, that, both, total = client().execute(c.sql, c.params).rows[0]
    return {"this": this, "other": that, "both": both, "total": total, "other_name": other["name"]}


def preview(definition: dict, parent_id: int | None = None, limit: int = 100) -> dict:
    comp = compiler(parent_id)
    parent = comp.parent
    cols = [c["name"] for c in parent["columns"] if not column_setting(parent, c["name"], "hidden")]
    select = ", ".join(
        (f"'••••' AS {quote_column(name)}" if column_setting(parent, name, "privacy") in HIDDEN_IN_PREVIEW
         else f"{quote_column(name, 'p')} AS {quote_column(name.replace('.', '_'))}")
        for name in cols)
    c = comp.compile(_empty(definition), select=select)
    res = client().execute(f"{c.sql}\nLIMIT {int(limit)}", c.params)
    return {"columns": res.column_names, "rows": res.rows,
            "primary_label": parent.get("label_column"), "secondary_label": parent.get("secondary_label")}


def breakdown(definition: dict, column: str | None = None, parent_id: int | None = None, source_kind: str = "property",
              model_id: int | None = None, metric: str = "users", limit: int = 12) -> list[dict]:
    """Group audience members by a property/trait, or count related/event rows by one of their
    columns (total rows vs unique customers)."""
    comp = compiler(parent_id)
    if source_kind in ("property", "trait"):
        expr, _ = comp.parent_column(column)
        c = comp.compile(_empty(definition), select=f"{expr} AS __g")
        sql = (f"SELECT CAST(__g AS STRING) AS value, COUNT(*) AS n FROM (\n{c.sql}\n) "
               f"GROUP BY 1 ORDER BY n DESC LIMIT {int(limit)}")
        return [{"value": v, "count": n} for v, n in client().execute(sql, c.params).rows]
    m = comp.model(model_id)
    col = quote_column(comp.column(m, column)["name"], "r")
    pk = quote_column(comp.parent["primary_key"], "p")
    keys = comp.keys_match(m, "r")
    count = "COUNT(*)" if metric == "rows" else f"COUNT(DISTINCT {pk})"
    where = comp.node(_empty(definition))
    c = comp.wrap(f"SELECT CAST({col} AS STRING) AS value, {count} AS n FROM {source(m)} r "
                  f"JOIN {comp.parent_from()} ON {keys} WHERE {where} GROUP BY 1 ORDER BY n DESC LIMIT {int(limit)}")
    return [{"value": v, "count": n} for v, n in client().execute(c.sql, c.params).rows]


def trait_preview(method: str, cfg: dict, parent_id: int | None = None, limit: int = 20) -> dict:
    comp = compiler(parent_id)
    expr = comp.trait_expr(method, cfg, "preview_trait")
    label = comp.parent.get("label_column") or comp.parent["primary_key"]
    c = comp.compile(_empty(None), select=f"{quote_column(label, 'p')} AS customer, {expr} AS value")
    res = client().execute(f"SELECT * FROM (\n{c.sql}\n) WHERE value IS NOT NULL LIMIT {int(limit)}", c.params)
    return {"columns": res.column_names, "rows": res.rows}


def total_customers(parent_id: int | None = None) -> int:
    comp = compiler(parent_id)
    return client().execute(f"SELECT COUNT(*) FROM {comp.parent_from()}").rows[0][0]
