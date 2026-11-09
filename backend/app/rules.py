"""Segmentation rules: operator catalog + filter-tree -> parameterised SQL compiler.

Filter tree shape (JSON, stored on the segment):
  {"type": "group", "op": "and" | "or", "children": [ <group> | <condition>, ... ]}
  {"type": "condition", "property": "email", "operator": "equals", "values": ["a@b.com"]}
"""
import re
from dataclasses import dataclass, field

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# kind: multi  -> one or more values (OR'd; for negative operators AND'd)
#       single -> exactly one value
#       days   -> one integer
#       none   -> no value
# `types` = column categories the operator is offered for in the UI.
OPERATORS = [
    {"key": "equals", "label": "equals", "kind": "multi", "types": ["string", "number", "date", "boolean"]},
    {"key": "does not equal", "label": "does not equal", "kind": "multi", "types": ["string", "number", "date", "boolean"]},
    {"key": "contains", "label": "contains", "kind": "multi", "types": ["string"]},
    {"key": "does not contain", "label": "does not contain", "kind": "multi", "types": ["string"]},
    {"key": "starts with", "label": "starts with", "kind": "multi", "types": ["string"]},
    {"key": "does not start with", "label": "does not start with", "kind": "multi", "types": ["string"]},
    {"key": "ends with", "label": "ends with", "kind": "multi", "types": ["string"]},
    {"key": "does not end with", "label": "does not end with", "kind": "multi", "types": ["string"]},
    {"key": "greater than", "label": "greater than", "kind": "single", "types": ["number"]},
    {"key": "greater than or equal", "label": "greater than or equal to", "kind": "single", "types": ["number"]},
    {"key": "less than", "label": "less than", "kind": "single", "types": ["number"]},
    {"key": "less than or equal", "label": "less than or equal to", "kind": "single", "types": ["number"]},
    {"key": "is true", "label": "is true", "kind": "none", "types": ["boolean"]},
    {"key": "is false", "label": "is false", "kind": "none", "types": ["boolean"]},
    {"key": "is before", "label": "is before", "kind": "single", "types": ["date"]},
    {"key": "is after", "label": "is after", "kind": "single", "types": ["date"]},
    {"key": "in last days", "label": "is within the last N days", "kind": "days", "types": ["date"]},
    {"key": "not in last days", "label": "is not within the last N days", "kind": "days", "types": ["date"]},
    {"key": "exists", "label": "exists", "kind": "none", "types": ["string", "number", "date", "boolean"]},
    {"key": "exists and is not empty", "label": "exists and is not empty", "kind": "none", "types": ["string"]},
    {"key": "does not exist", "label": "does not exist", "kind": "none", "types": ["string", "number", "date", "boolean"]},
]
OPS = {o["key"]: o for o in OPERATORS}

NUMERIC_HINTS = ("int", "long", "double", "float", "decimal", "numeric", "real", "short", "byte", "number")


class RuleError(ValueError):
    pass


def categorize(sql_type: str) -> str:
    t = (sql_type or "").lower()
    if "bool" in t:
        return "boolean"
    if "date" in t or "time" in t:
        return "date"
    if any(h in t for h in NUMERIC_HINTS):
        return "number"
    return "string"


@dataclass
class Ctx:
    dialect: str  # "databricks" | "sqlite"
    columns: dict[str, str]  # name -> category
    alias: str = "p"
    # related models usable in conditions: id -> {table, columns, parent_key, related_key}
    relations: dict = field(default_factory=dict)
    counter: list = field(default_factory=lambda: [0])
    no_filter: set = field(default_factory=set)  # columns blocked from filters by privacy level

    def quote(self, ident: str) -> str:
        if self.columns and ident not in self.columns:
            raise RuleError(f"Unknown property '{ident}'")
        if not self.columns and not IDENT.match(ident):
            raise RuleError(f"Invalid property name '{ident}'")
        q = f"`{ident}`" if self.dialect == "databricks" else f'"{ident}"'
        return f"{self.alias}.{q}"

    @property
    def str_type(self) -> str:
        return "STRING" if self.dialect == "databricks" else "TEXT"


def quote_table(table: str, dialect: str) -> str:
    parts = table.split(".")
    if not 1 <= len(parts) <= 3 or not all(IDENT.match(p) for p in parts):
        raise RuleError(f"Invalid table name '{table}'")
    q = "`" if dialect == "databricks" else '"'
    return ".".join(f"{q}{p}{q}" for p in parts)


def _like_escape(v: str) -> str:
    return v.replace("!", "!!").replace("%", "!%").replace("_", "!_")


def _coerce(v, category: str):
    if category == "number":
        try:
            f = float(v)
            return int(f) if f.is_integer() else f
        except (TypeError, ValueError):
            raise RuleError(f"'{v}' is not a number")
    if category == "boolean":
        return str(v).lower() in ("1", "true", "yes")
    return str(v)


def _condition(c: dict, ctx: Ctx) -> tuple[str, list]:
    prop, op = c.get("property"), c.get("operator")
    if not prop:
        raise RuleError("A condition is missing its property")
    spec = OPS.get(op)
    if not spec:
        raise RuleError(f"Unknown operator '{op}'")
    if prop in ctx.no_filter:
        raise RuleError(f"'{prop}' can't be used in filters (its privacy level doesn't allow it)")
    col = ctx.quote(prop)
    cat = ctx.columns.get(prop, "string")
    text = f"LOWER(CAST({col} AS {ctx.str_type}))"
    kind = spec["kind"]
    vals = [v for v in (c.get("values") or []) if v is not None and str(v).strip() != ""]

    if kind == "none":
        sql = {
            "exists": f"{col} IS NOT NULL",
            "exists and is not empty": f"({col} IS NOT NULL AND TRIM(CAST({col} AS {ctx.str_type})) <> '')",
            "does not exist": f"{col} IS NULL",
            "is true": f"{col} = TRUE",
            "is false": f"{col} = FALSE",
        }[op]
        return sql, []

    if not vals:
        raise RuleError(f"'{prop} {op}' requires a value")

    if kind == "days":
        try:
            n = int(vals[0])
        except ValueError:
            raise RuleError("Number of days must be an integer")
        if n < 0:
            raise RuleError("Number of days must be positive")
        if ctx.dialect == "databricks":
            bound = f"date_sub(current_date(), {n})"
            left = col
        else:
            bound = f"date('now', '-{n} days')"
            left = f"date({col})"
        if op == "in last days":
            return f"{left} >= {bound}", []
        return f"({col} IS NULL OR {left} < {bound})", []

    if kind == "single":
        sym = {
            "greater than": ">", "greater than or equal": ">=",
            "less than": "<", "less than or equal": "<=",
            "is before": "<", "is after": ">",
        }[op]
        return f"{col} {sym} ?", [_coerce(vals[0], cat if cat in ("number",) else "string")]

    # multi-value string-ish operators
    positive_op = {
        "equals": "equals", "does not equal": "equals", "contains": "contains", "does not contain": "contains",
        "starts with": "starts with", "does not start with": "starts with",
        "ends with": "ends with", "does not end with": "ends with",
    }[op]
    negative = op.startswith("does not ")
    frags, params = [], []
    for v in vals:
        if positive_op == "equals":
            frags.append(f"{col} = ?")
            params.append(_coerce(v, cat))
            continue
        v = str(v).lower()
        pat = {
            "contains": f"%{_like_escape(v)}%",
            "starts with": f"{_like_escape(v)}%",
            "ends with": f"%{_like_escape(v)}",
        }[positive_op]
        frags.append(f"{text} LIKE ? ESCAPE '!'")
        params.append(pat)

    if negative:
        inner = " AND ".join(f"NOT ({f})" for f in frags)
        return f"({col} IS NULL OR ({inner}))", params
    return "(" + " OR ".join(frags) + ")", params


def _related(c: dict, ctx: Ctx) -> tuple[str, list]:
    """Condition on a related/event model -> correlated EXISTS (NOT EXISTS when has=false).
    Without a property it just tests that a matching record exists."""
    try:
        rel = ctx.relations[int(c["related_id"])]
    except (KeyError, ValueError):
        raise RuleError("Unknown related model")
    ctx.counter[0] += 1
    rctx = Ctx(ctx.dialect, rel["columns"], alias=f"r{ctx.counter[0]}", no_filter=set(rel.get("no_filter") or []))
    pairs = [(rel["parent_key"], rel["related_key"])] + [tuple(p) for p in rel.get("extra_keys") or []]
    parts = [f"{rctx.quote(r)} = {ctx.quote(p)}" for p, r in pairs]
    params: list = []
    if c.get("property"):
        inner, params = _condition(c, rctx)
        parts.append(inner)
    days = c.get("event_days")
    if rel.get("timestamp_column") and days not in (None, ""):
        try:
            n = int(days)
        except (TypeError, ValueError):
            raise RuleError("Event window must be a number of days")
        if n < 0:
            raise RuleError("Event window must be positive")
        ts = rctx.quote(rel["timestamp_column"])
        if ctx.dialect == "databricks":
            parts.append(f"{ts} >= date_sub(current_date(), {n})")
        else:
            parts.append(f"date({ts}) >= date('now', '-{n} days')")
    count_op = c.get("count_op")
    if count_op:  # count-based: at least / at most / exactly N matching related rows
        if count_op not in ("at_least", "at_most", "exactly"):
            raise RuleError("Unknown count operator")
        try:
            n = int(c.get("count"))
        except (TypeError, ValueError):
            raise RuleError("Count must be a whole number")
        if n < 0:
            raise RuleError("Count must be zero or more")
        sym = {"at_least": ">=", "at_most": "<=", "exactly": "="}[count_op]
        sub = f"SELECT COUNT(*) FROM {quote_table(rel['table'], ctx.dialect)} AS {rctx.alias} WHERE {' AND '.join(parts)}"
        return f"(({sub}) {sym} {n})", params
    sql = f"EXISTS (SELECT 1 FROM {quote_table(rel['table'], ctx.dialect)} AS {rctx.alias} WHERE {' AND '.join(parts)})"
    return ("NOT " + sql if c.get("has") is False else sql), params


def compile_filter(node: dict | None, ctx: Ctx) -> tuple[str, list]:
    """Returns (where_sql, params) using '?' placeholders."""
    if not node or (node.get("type") == "group" and not node.get("children")):
        return "1=1", []
    if node.get("type") == "condition":
        return _related(node, ctx) if node.get("related_id") else _condition(node, ctx)
    if node.get("type") != "group":
        raise RuleError("Invalid filter node")
    joiner = " OR " if node.get("op") == "or" else " AND "
    parts, params = [], []
    for ch in node["children"]:
        s, p = compile_filter(ch, ctx)
        parts.append(s)
        params += p
    return "(" + joiner.join(parts) + ")", params


def build_select(table: str, select_cols: list[str], filt: dict | None, ctx: Ctx, limit: int | None = None):
    ctx.counter[0] = 0
    where, params = compile_filter(filt, ctx)
    cols = ", ".join(ctx.quote(c) for c in select_cols) if select_cols else f"{ctx.alias}.*"
    sql = f"SELECT {cols} FROM {quote_table(table, ctx.dialect)} AS {ctx.alias} WHERE {where}"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return sql, params


def build_count(table: str, filt: dict | None, ctx: Ctx):
    ctx.counter[0] = 0
    where, params = compile_filter(filt, ctx)
    return f"SELECT COUNT(*) FROM {quote_table(table, ctx.dialect)} AS {ctx.alias} WHERE {where}", params


def inline(sql: str, params: list) -> str:
    """Render params into the SQL for display only (never executed)."""
    it = iter(params)

    def lit(_):
        v = next(it)
        if isinstance(v, bool):
            return "TRUE" if v else "FALSE"
        if isinstance(v, (int, float)):
            return str(v)
        return "'" + str(v).replace("'", "''") + "'"

    return re.sub(r"\?", lit, sql)
