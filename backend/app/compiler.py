"""Segment definition (JSON condition tree) -> parameterized Databricks SQL.

Node types
----------
group     {"type":"group","op":"and|or","conditions":[...]}
property  {"type":"property","column":..,"operator":..,"values":[..],"value":..,"value2":..,
           "direction":"previous|next","amount":..,"unit":..,"calendar":bool,
           "compare":{"column":..}}                       # compare with another column instead of a value
relation  {"type":"relation","model_id":..,"filter":group,"time_window":tw,
           "aggregate":{"fn":"count|count_distinct|sum|avg|min|max","column":..,"operator":..,"value":..,"value2":..}}
event     {"type":"event","model_id":..,"did":bool,"event_names":[..],"filter":group,"time_window":tw,
           "frequency":{"operator":..,"value":..},
           "then":{"did":bool,"model_id":..,"event_names":[..],"filter":group,"within":{"amount":..,"unit":..}}}
audience  {"type":"audience","audience_id":..,"included":bool}
trait     {"type":"trait","trait_id":.. | "inline":{method config},"operator":..,"values"/"value":..}
split     {"type":"split","audience_id":..,"groups":[{"name","percent"}],"group":name}   (internal, sync time)
(legacy)  {"type":"sequence",...} is compiled as an event with `then`.

Parent columns include virtual columns: "trait.<id>" (saved traits) and
"merged.<model_id>.<col>" (columns merged from a 1:1 / many:1 related model).

Operators follow Hightouch's audience-filter reference:
  string    equals, not_equals, contains, not_contains, starts_with, not_starts_with, ends_with,
            not_ends_with, exists, exists_not_empty, not_exists
  number    equals, not_equals, gt, lt, gte, lte, between, exists, not_exists
  boolean   equals, not_equals, exists, not_exists
  timestamp equals, before, after, within, not_within, between, anniversary, exists, not_exists
`equals` / `not_equals` accept several values (any of / none of).

Time window (tw): {"type":"anytime|within|not_within|before|after|between","direction":"previous|next",
                   "amount":..,"unit":"minute|hour|day|week|month|year","calendar":bool,
                   "date":..,"from":..,"to":..}

Trait methods (cfg): aggregation {model_id, fn: sum|avg, column}, count {model_id, column?},
occurrence {model_id, occurrence: first|last|most_frequent|least_frequent, column, order_by?},
list {model_id, column, order_by?, descending?, distinct?, limit?},
sql_aggregation {model_id, sql with {{column "x"}}, result_type},
sql_formula {formula with {{column "x"}} / {{trait "Name"}}, result_type}.
All take optional filter / time_window / event_names that decide which records contribute.

All user values become named query parameters; identifiers are validated against the
model's introspected columns and backtick-quoted, so definitions cannot inject SQL.
(SQL models and SQL traits are admin-authored SQL by design.)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from .catalog import quote_column, quote_ident, quote_table

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UNITS = {"minute": "MINUTE", "hour": "HOUR", "day": "DAY", "week": "DAY", "month": "MONTH", "year": "YEAR"}
TRUNC = {"minute": "MINUTE", "hour": "HOUR", "day": "DAY", "week": "WEEK", "month": "MONTH", "year": "YEAR"}
COMPARATORS = {"equals": "=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
PY_COMPARE: dict[str, Callable[[float, float], bool]] = {
    "equals": lambda a, b: a == b,
    "not_equals": lambda a, b: a != b,
    "gt": lambda a, b: a > b,
    "gte": lambda a, b: a >= b,
    "lt": lambda a, b: a < b,
    "lte": lambda a, b: a <= b,
}
# Older saved definitions used these names.
LEGACY_OPS = {"in": "equals", "not_in": "not_equals", "is_null": "not_exists", "is_not_null": "exists", "on": "equals"}
LEGACY_WINDOWS = {"within_last": ("within", "previous"), "within_next": ("within", "next"),
                  "not_within_last": ("not_within", "previous")}
MAX_AUDIENCE_DEPTH = 5
TEMPLATE_RE = re.compile(r'\{\{\s*(column|trait)\s+"([^"]+)"\s*\}\}')
SQL_START = re.compile(r"^\s*(select|with)\b", re.I)
PRIVACY_BLOCKS = {"filter": {"blocked", "sync_only"}, "sync": {"blocked", "sync_blocked"}}


class CompileError(ValueError):
    pass


# ---- schema helpers (shared with the sync engine) ------------------------------

def source(model: dict) -> str:
    """FROM-able SQL for a model: a table, or a SQL query model."""
    if model.get("query_type") == "sql":
        sql = (model.get("sql") or "").strip().rstrip(";")
        if not SQL_START.match(sql):
            raise CompileError(f"{model['name']}: SQL models must start with SELECT or WITH")
        return f"({sql})"
    return quote_table(model["table_ref"])


def join_keys(model: dict, parent: dict) -> list[dict]:
    keys = model.get("join_keys") or []
    if not keys and model.get("foreign_key"):
        keys = [{"parent": model.get("parent_key") or parent["primary_key"], "model": model["foreign_key"]}]
    if not keys:
        raise CompileError(f"{model['name']} isn't linked to the customer table")
    return keys


def column_setting(model: dict, column: str, key: str, default=None):
    return ((model.get("column_settings") or {}).get(column) or {}).get(key, default)


def check_privacy(model: dict, column: str, purpose: str) -> None:
    level = column_setting(model, column, "privacy", "unreviewed")
    if level in PRIVACY_BLOCKS.get(purpose, set()):
        what = "filtering" if purpose == "filter" else "syncing"
        raise CompileError(f"{column} can't be used for {what} (privacy level: {level.replace('_', '-')})")


@dataclass
class Compiled:
    sql: str
    params: list[dict]
    ctes: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class _Shared:
    params: list[dict] = field(default_factory=list)
    ctes: list[tuple[str, str]] = field(default_factory=list)
    counter: int = 0


class Compiler:
    """`schema` = {"parent": model, "models": {id: model}, "traits": {id: trait}}.
    `load_audience(id)` returns another audience's definition (for include/exclude).
    `null_matches_negation`: whether null values satisfy negative operators such as
    `does not equal` (Hightouch's "treat null values like any other value")."""

    def __init__(self, schema: dict, as_of: str | None = None, load_audience: Callable[[int], dict] | None = None,
                 _shared: _Shared | None = None, _alias: str = "p", _depth: int = 0, null_matches_negation: bool = True):
        self.parent = schema.get("parent")
        if not self.parent:
            raise CompileError("No parent model configured. Set one up under Data setup.")
        self.schema = schema
        self.models = {int(k): v for k, v in schema.get("models", {}).items()}
        self.traits = {int(k): v for k, v in (schema.get("traits") or {}).items()}
        if as_of and not DATE_RE.match(as_of):
            raise CompileError("as_of must be YYYY-MM-DD")
        self.as_of = as_of
        self.load_audience = load_audience
        self.s = _shared or _Shared()
        self.alias = _alias
        self.depth = _depth
        self.null_negation = null_matches_negation

    # ---- public ------------------------------------------------------------
    def compile(self, definition: dict, select: str | None = None, from_: str | None = None) -> Compiled:
        """`from_` overrides the FROM clause; it must still expose the parent as alias `p`
        (e.g. an event table joined to the parent, for event syncs)."""
        where = self.node(definition or {"type": "group", "op": "and", "conditions": []})
        return self.wrap(f"SELECT {select or f'{self.alias}.*'}\nFROM {from_ or self.parent_from()}\nWHERE {where}")

    def funnel(self, definition: dict) -> Compiled:
        """Cumulative member counts after each top-level condition (for AND audiences)."""
        conds = (definition or {}).get("conditions", [])
        preds = [self.node(c) for c in conds]
        cols = ["COUNT(*)"]
        for i in range(len(preds)):
            cols.append(f"COUNT_IF({' AND '.join(f'({p})' for p in preds[: i + 1])})")
        return self.wrap(f"SELECT {', '.join(cols)}\nFROM {self.parent_from()}")

    def parent_from(self) -> str:
        return f"{source(self.parent)} {self.alias}"

    def wrap(self, body: str) -> Compiled:
        if self.s.ctes:
            with_ = ",\n".join(f"{name} AS (\n  {sql}\n)" for name, sql in self.s.ctes)
            body = f"WITH {with_}\n{body}"
        return Compiled(body, self.s.params, self.s.ctes)

    # ---- helpers -------------------------------------------------------------
    @property
    def now(self) -> str:
        return f"TIMESTAMP'{self.as_of} 23:59:59'" if self.as_of else "current_timestamp()"

    @property
    def today(self) -> str:
        return f"DATE'{self.as_of}'" if self.as_of else "current_date()"

    def param(self, value: Any, type_: str = "STRING") -> str:
        name = f"p{len(self.s.params)}"
        p = {"name": name, "type": type_}
        if value is not None:
            p["value"] = str(value)
        self.s.params.append(p)
        return f":{name}"

    def next_name(self, base: str) -> str:
        self.s.counter += 1
        return re.sub(r"[^A-Za-z0-9_]", "_", base).lower() + f"_{self.s.counter}"

    def model(self, model_id) -> dict:
        try:
            return self.models[int(model_id)]
        except (KeyError, TypeError, ValueError):
            raise CompileError(f"Unknown model id {model_id!r}")

    @staticmethod
    def column(model: dict, name: str | None) -> dict:
        for c in model.get("columns", []):
            if c["name"] == name:
                return c
        raise CompileError(f"Unknown column {name!r} on {model['name']}")

    @staticmethod
    def amount(value) -> int:
        try:
            n = int(value)
        except (TypeError, ValueError):
            raise CompileError("Time amount must be a whole number")
        if n < 0:
            raise CompileError("Time amount can't be negative")
        return n

    def interval(self, amount, unit: str) -> str:
        n = self.amount(amount)
        if unit not in UNITS:
            raise CompileError(f"Invalid time unit {unit!r}")
        if unit == "week":
            n *= 7
        return f"INTERVAL {n} {UNITS[unit]}"

    def date_param(self, value) -> str:
        if not isinstance(value, str) or not DATE_RE.match(value[:10]):
            raise CompileError(f"Expected a date (YYYY-MM-DD), got {value!r}")
        return f"CAST({self.param(value[:10])} AS TIMESTAMP)"

    def negate(self, col: str, expr: str) -> str:
        """Negative operators: whether null rows match follows the workspace null setting."""
        return f"({col} IS NULL OR NOT ({expr}))" if self.null_negation else f"({col} IS NOT NULL AND NOT ({expr}))"

    # ---- joins, columns, traits -------------------------------------------------
    def keys_match(self, model: dict, model_alias: str) -> str:
        return " AND ".join(f"{quote_column(k['model'], model_alias)} = {quote_column(k['parent'], self.alias)}"
                            for k in join_keys(model, self.parent))

    def model_keys(self, model: dict, alias: str) -> list[str]:
        return [quote_column(k["model"], alias) for k in join_keys(model, self.parent)]

    def cte_match(self, model: dict, cte_alias: str) -> str:
        return " AND ".join(f"{cte_alias}.__k{i} = {quote_column(k['parent'], self.alias)}"
                            for i, k in enumerate(join_keys(model, self.parent)))

    def parent_column(self, name: str | None, purpose: str = "filter") -> tuple[str, dict]:
        """SQL expression + column info for a parent column (real, merged or trait)."""
        if isinstance(name, str) and name.startswith("trait."):
            try:
                trait = self.traits[int(name.split(".", 1)[1])]
            except (KeyError, ValueError):
                raise CompileError(f"Unknown trait {name!r}")
            expr = self.trait_expr(trait["method"], trait["config"], f"trait_{trait['id']}")
            return expr, {"name": name, "type": trait_type(trait["method"], trait["config"], self)}
        if isinstance(name, str) and name.startswith("merged."):
            try:
                _, mid, col = name.split(".", 2)
                m = self.model(mid)
            except ValueError:
                raise CompileError(f"Unknown merged column {name!r}")
            if col not in (m.get("merge_columns") or []):
                raise CompileError(f"{col} is not merged from {m['name']}")
            info = self.column(m, col)
            check_privacy(m, col, purpose)
            expr = f"(SELECT first(x.{quote_ident(col)}) FROM {source(m)} x WHERE {self.keys_match(m, 'x')})"
            return expr, {**info, "name": name}
        info = self.column(self.parent, name)
        check_privacy(self.parent, info["name"], purpose)
        return quote_column(info["name"], self.alias), info

    def trait_expr(self, method: str, cfg: dict, cache_key: str) -> str:
        """Per-customer value of a trait. Aggregating traits become a CTE keyed by the join keys."""
        if method == "sql_formula":
            return "(" + self.render_formula(cfg.get("formula", "")) + ")"
        m = self.model(cfg.get("model_id"))
        if not any(name == cache_key for name, _ in self.s.ctes):
            keys = self.model_keys(m, "t")
            cols = ", ".join(f"{k} AS __k{i}" for i, k in enumerate(keys))
            where = self._filters(m, "t", cfg.get("filter"), cfg.get("time_window"), cfg.get("event_names"))
            where_sql = f" WHERE {' AND '.join(where)}" if where else ""
            if method == "occurrence" and cfg.get("occurrence") in ("most_frequent", "least_frequent"):
                col = quote_column(self.column(m, cfg.get("column"))["name"], "t")
                pick = "max_by" if cfg["occurrence"] == "most_frequent" else "min_by"
                knames = ", ".join(f"__k{i}" for i in range(len(keys)))
                inner = f"SELECT {cols}, {col} AS val, COUNT(*) AS n FROM {source(m)} t{where_sql} GROUP BY {', '.join(keys)}, {col}"
                sql = f"SELECT {knames}, {pick}(val, n) AS v FROM ({inner}) GROUP BY {knames}"
            else:
                sql = f"SELECT {cols}, {self.trait_aggregate(method, cfg, m)} AS v FROM {source(m)} t{where_sql} GROUP BY {', '.join(keys)}"
            self.s.ctes.append((cache_key, sql))
        expr = f"(SELECT first(c.v) FROM {cache_key} c WHERE {self.cte_match(m, 'c')})"
        return f"coalesce({expr}, 0)" if method == "count" else expr

    def trait_aggregate(self, method: str, cfg: dict, m: dict) -> str:
        def col(name=None):
            return quote_column(self.column(m, name or cfg.get("column"))["name"], "t")
        if method == "aggregation":
            fn = {"sum": "SUM", "avg": "AVG"}.get(cfg.get("fn", "sum"))
            if not fn:
                raise CompileError("Aggregation must be Sum or Average")
            if self.column(m, cfg.get("column"))["type"] != "number":
                raise CompileError("Aggregation needs a numeric column")
            return f"{fn}({col()})"
        if method == "count":
            return f"COUNT(DISTINCT {col()})" if cfg.get("column") else "COUNT(*)"
        if method == "occurrence":
            order_col = cfg.get("order_by") or m.get("timestamp_column")
            if not order_col:
                raise CompileError("Choose a column to order by (first / last)")
            return f"{'min_by' if cfg.get('occurrence', 'last') == 'first' else 'max_by'}({col()}, {col(order_col)})"
        if method == "list":
            values = f"collect_list({col()})"
            if cfg.get("order_by"):
                desc = cfg.get("descending", True)
                values = (f"transform(array_sort(collect_list(struct({col(cfg['order_by'])} AS o, {col()} AS v)), "
                          f"(a, b) -> CASE WHEN a.o = b.o THEN 0 WHEN a.o {'>' if desc else '<'} b.o THEN -1 ELSE 1 END), x -> x.v)")
            if cfg.get("distinct"):
                values = f"array_distinct({values})"
            if cfg.get("limit"):
                values = f"slice({values}, 1, {self.amount(cfg['limit'])})"
            return values
        if method == "sql_aggregation":
            sql = cfg.get("sql", "")
            if not sql.strip():
                raise CompileError("Enter the SQL aggregation")
            return TEMPLATE_RE.sub(lambda mt: col(mt.group(2)) if mt.group(1) == "column" else mt.group(0), sql)
        raise CompileError(f"Unknown trait method {method!r}")

    def render_formula(self, sql: str) -> str:
        if not sql.strip():
            raise CompileError("Enter a formula")

        def sub(mt):
            kind, name = mt.group(1), mt.group(2)
            if kind == "trait":
                t = next((t for t in self.traits.values() if t["name"] == name), None)
                if not t or t["method"] == "sql_formula":
                    raise CompileError(f"Formula references an unknown or formula trait: {name!r}")
                return self.parent_column(f"trait.{t['id']}")[0]
            return self.parent_column(name)[0]
        return TEMPLATE_RE.sub(sub, sql)

    # ---- nodes ---------------------------------------------------------------
    def node(self, n: dict, model: dict | None = None, alias: str | None = None) -> str:
        """Compile a node. `model`/`alias` set when inside a relation/event filter."""
        t = n.get("type")
        model = model or self.parent
        alias = alias or self.alias
        if t == "group":
            parts = [self.node(c, model, alias) for c in n.get("conditions", [])]
            if not parts:
                return "TRUE"
            op = " OR " if n.get("op") == "or" else " AND "
            return "(" + op.join(parts) + ")"
        if t == "property":
            if model is self.parent:
                expr, col = self.parent_column(n.get("column"))
            else:
                col = self.column(model, n.get("column"))
                check_privacy(model, col["name"], "filter")
                expr = quote_column(col["name"], alias)
            case = column_setting(model, col["name"], "case_sensitive", False)
            return self.predicate(expr, col["type"], n, case_sensitive=case, model=model, alias=alias)
        if model is not self.parent:
            raise CompileError(f"'{t}' conditions are only allowed at the top level")
        if t == "relation":
            return self.relation(n)
        if t == "event":
            return self.event(n)
        if t == "sequence":
            return self.event(self._legacy_sequence(n))
        if t == "audience":
            return self.audience(n)
        if t == "trait":
            if n.get("trait_id"):
                expr, info = self.parent_column(f"trait.{n['trait_id']}")
            else:
                inline = n.get("inline") or {}
                self.s.counter += 1
                expr = self.trait_expr(inline.get("method", "count"), inline, f"inline_trait_{self.s.counter}")
                info = {"type": trait_type(inline.get("method", "count"), inline, self)}
            return self.predicate(expr, info["type"], n)
        if t == "split":
            return self.split(n)
        raise CompileError(f"Unknown condition type {t!r}")

    def predicate(self, col: str, ctype: str, n: dict, case_sensitive: bool = False,
                  model: dict | None = None, alias: str | None = None) -> str:
        op = LEGACY_OPS.get(n.get("operator"), n.get("operator"))
        if n.get("operator") in LEGACY_WINDOWS:
            op, n = "within" if n["operator"] != "not_within_last" else "not_within", {
                **n, "direction": LEGACY_WINDOWS[n["operator"]][1]}
        if n.get("operator") in ("is_true", "is_false"):
            op, n = "equals", {**n, "values": [n["operator"] == "is_true"]}

        if n.get("compare") and op in ("equals", "not_equals", "gt", "gte", "lt", "lte"):
            other_name = n["compare"].get("column")
            if model is None or model is self.parent:
                other = self.parent_column(other_name)[0]
            else:
                other = quote_column(self.column(model, other_name)["name"], alias)
            return f"{col} {'<>' if op == 'not_equals' else COMPARATORS[op]} {other}"

        if op == "exists":
            return f"{col} IS NOT NULL"
        if op == "not_exists":
            return f"{col} IS NULL"
        if op == "exists_not_empty":
            return f"({col} IS NOT NULL AND trim(CAST({col} AS STRING)) <> '')"

        if ctype in ("date", "timestamp"):
            return self.time_predicate(col, op, n)

        values = n.get("values")
        if values is None and n.get("value") not in (None, ""):
            values = [n.get("value")]

        if ctype == "boolean":
            if op not in ("equals", "not_equals") or not values:
                raise CompileError("Choose true or false")
            v = values[0] in (True, "true", "True", 1, "1")
            expr = f"{col} = {self.param(v, 'BOOLEAN')}"
            return expr if op == "equals" else self.negate(col, expr)

        def val(x):
            if ctype == "number":
                try:
                    x = float(x)
                except (TypeError, ValueError):
                    raise CompileError(f"Expected a number, got {x!r}")
                return self.param(x, "DOUBLE")
            return self.param(x)

        if op in ("equals", "not_equals"):
            if not values:
                raise CompileError("Enter at least one value")
            if ctype == "string" and not case_sensitive:
                expr = f"lower({col}) IN ({', '.join(f'lower({val(x)})' for x in values)})"
            else:
                expr = f"{col} IN ({', '.join(val(x) for x in values)})"
            return expr if op == "equals" else self.negate(col, expr)
        if op in ("contains", "not_contains", "starts_with", "not_starts_with", "ends_with", "not_ends_with"):
            if not values:
                raise CompileError("Enter a value")
            fn = {"contains": "contains", "starts_with": "startswith", "ends_with": "endswith"}[op.removeprefix("not_")]
            if case_sensitive:
                expr = " OR ".join(f"{fn}(CAST({col} AS STRING), {self.param(x)})" for x in values)
            else:
                expr = " OR ".join(f"{fn}(lower(CAST({col} AS STRING)), lower({self.param(x)}))" for x in values)
            return f"({expr})" if not op.startswith("not_") else self.negate(col, expr)
        if op in ("gt", "gte", "lt", "lte"):
            return f"{col} {COMPARATORS[op]} {val(n.get('value'))}"
        if op == "between":
            return f"{col} BETWEEN {val(n.get('value'))} AND {val(n.get('value2'))}"
        raise CompileError(f"Unsupported operator {op!r} for {ctype} column")

    def time_predicate(self, col: str, op: str, n: dict) -> str:
        if op == "equals":
            return f"CAST({col} AS DATE) = CAST({self.param((n.get('value') or '')[:10] or None)} AS DATE)"
        if op == "anniversary":
            return self.anniversary(col, n.get("direction", "next"), n.get("amount", 0))
        if op in ("within", "not_within", "before", "after", "between"):
            return self.time_window(col, {"type": op, "direction": n.get("direction", "previous"),
                                          "amount": n.get("amount"), "unit": n.get("unit", "day"),
                                          "calendar": n.get("calendar"), "date": n.get("value"),
                                          "from": n.get("value"), "to": n.get("value2")})
        raise CompileError(f"Unsupported operator {op!r} for a date column")

    def anniversary(self, col: str, direction: str, amount) -> str:
        """Recurring date (birthday, renewal) falls within the next/previous N days (0 = today)."""
        days = self.amount(amount)
        d = f"CAST({col} AS DATE)"
        this_year = f"add_months({d}, 12 * (year({self.today}) - year({d})))"
        if direction == "previous":
            last = f"CASE WHEN {this_year} <= {self.today} THEN {this_year} ELSE add_months({this_year}, -12) END"
            return f"({col} IS NOT NULL AND datediff({self.today}, {last}) BETWEEN 0 AND {days})"
        nxt = f"CASE WHEN {this_year} >= {self.today} THEN {this_year} ELSE add_months({this_year}, 12) END"
        return f"({col} IS NOT NULL AND datediff({nxt}, {self.today}) BETWEEN 0 AND {days})"

    def time_window(self, col: str, tw: dict | None) -> str:
        if not tw or tw.get("type", "anytime") == "anytime":
            return "TRUE"
        t = tw["type"]
        if t in LEGACY_WINDOWS:
            t, direction = LEGACY_WINDOWS[t]
            tw = {**tw, "type": t, "direction": direction}
        ts = f"CAST({col} AS TIMESTAMP)"
        if t in ("within", "not_within"):
            expr = self.within(ts, tw)
            return expr if t == "within" else f"({ts} IS NOT NULL AND NOT {expr})"
        if t == "before":
            return f"{ts} < {self.date_param(tw.get('date') or tw.get('from'))}"
        if t == "after":
            return f"{ts} >= {self.date_param(tw.get('date') or tw.get('from'))}"
        if t == "between":
            return f"({ts} >= {self.date_param(tw.get('from'))} AND {ts} < {self.date_param(tw.get('to'))} + INTERVAL 1 DAY)"
        raise CompileError(f"Unknown time window {t!r}")

    def within(self, ts: str, tw: dict) -> str:
        unit = tw.get("unit", "day")
        if unit not in UNITS:
            raise CompileError(f"Invalid time unit {unit!r}")
        span = self.interval(tw.get("amount"), unit)
        nxt = tw.get("direction") == "next"
        if tw.get("calendar"):
            # Completed calendar units, e.g. previous 2 calendar months on June 3 = Apr 1 – May 31.
            start = f"date_trunc('{TRUNC[unit]}', {self.now})"
            one = self.interval(1, unit)
            if nxt:
                return f"({ts} >= {start} + {one} AND {ts} < {start} + {one} + {span})"
            return f"({ts} >= {start} - {span} AND {ts} < {start})"
        if nxt:
            return f"({ts} > {self.now} AND {ts} <= {self.now} + {span})"
        return f"({ts} >= {self.now} - {span} AND {ts} <= {self.now})"

    def _filters(self, model: dict, alias: str, filt: dict | None, tw: dict | None, event_names: list | None) -> list[str]:
        where = []
        if filt and filt.get("conditions"):
            where.append(self.node(filt, model, alias))
        if tw and tw.get("type", "anytime") != "anytime":
            if not model.get("timestamp_column"):
                raise CompileError(f"{model['name']} has no timestamp column, so time windows can't be used")
            where.append(self.time_window(quote_column(model["timestamp_column"], alias), tw))
        if event_names:
            if not model.get("event_name_column"):
                raise CompileError(f"{model['name']} has no event name column")
            lst = ", ".join(self.param(e) for e in event_names)
            where.append(f"{quote_column(model['event_name_column'], alias)} IN ({lst})")
        return where

    def _grouped(self, m: dict, alias: str, metric: str, join: str, where: list[str]) -> str:
        keys = self.model_keys(m, alias)
        cols = ", ".join(f"{k} AS __k{i}" for i, k in enumerate(keys))
        return (f"SELECT {cols}, {metric} AS __v FROM {source(m)} {alias}{join}"
                + (f" WHERE {' AND '.join(where)}" if where else "") + f" GROUP BY {', '.join(keys)}")

    def _membership(self, model: dict, cte_sql: str, fn: str, operator: str, value, value2=None) -> str:
        """Register an aggregate CTE (__k0.. = join keys, __v = metric) and return the
        WHERE predicate on the parent. Handles the 'zero matches' case for counts:
        e.g. "did NOT do X" or "at most 2 bookings" must include people with no rows."""
        name = self.next_name(model["name"])
        self.s.ctes.append((name, cte_sql))
        if operator == "between":
            try:
                lo, hi = float(value), float(value2)
            except (TypeError, ValueError):
                raise CompileError("Enter both numbers for 'between'")
            cond = f"c.__v BETWEEN {self.param(lo, 'DOUBLE')} AND {self.param(hi, 'DOUBLE')}"
            zero_ok = lo <= 0 <= hi
        else:
            if operator not in PY_COMPARE:
                raise CompileError(f"Unsupported operator {operator!r}")
            try:
                num = float(value)
            except (TypeError, ValueError):
                raise CompileError(f"Expected a number, got {value!r}")
            cond = f"c.__v {'<>' if operator == 'not_equals' else COMPARATORS[operator]} {self.param(num, 'DOUBLE')}"
            zero_ok = PY_COMPARE[operator](0, num)
        match = self.cte_match(model, "c")
        if fn in ("count", "count_distinct") and zero_ok:
            return f"NOT EXISTS (SELECT 1 FROM {name} c WHERE {match} AND NOT ({cond}))"
        return f"EXISTS (SELECT 1 FROM {name} c WHERE {match} AND {cond})"

    def relation(self, n: dict) -> str:
        m = self.model(n.get("model_id"))
        agg = n.get("aggregate") or {"fn": "count", "operator": "gte", "value": 1}
        fn = agg.get("fn", "count")
        if fn == "count":
            metric = "COUNT(*)"
        elif fn in ("count_distinct", "sum", "avg", "min", "max"):
            col = self.column(m, agg.get("column"))
            if fn != "count_distinct" and col["type"] != "number":
                raise CompileError(f"{fn} needs a numeric column")
            c = quote_column(col["name"], "r")
            metric = f"COUNT(DISTINCT {c})" if fn == "count_distinct" else f"{fn.upper()}({c})"
        else:
            raise CompileError(f"Unknown aggregation {fn!r}")
        where = self._filters(m, "r", n.get("filter"), n.get("time_window"), None)
        return self._membership(m, self._grouped(m, "r", metric, "", where), fn,
                                agg.get("operator", "gte"), agg.get("value", 1), agg.get("value2"))

    def event(self, n: dict) -> str:
        m = self.model(n.get("model_id"))
        where = self._filters(m, "e", n.get("filter"), n.get("time_window"), n.get("event_names"))
        then = n.get("then") if n.get("did", True) else None
        join = ""
        if then:
            b = self.model(then.get("model_id"))
            for x in (m, b):
                if not x.get("timestamp_column"):
                    raise CompileError(f"{x['name']} needs a timestamp column for 'then did' conditions")
            ka, kb = join_keys(m, self.parent), join_keys(b, self.parent)
            if [k["parent"] for k in ka] != [k["parent"] for k in kb]:
                raise CompileError("Both events must link to the customer with the same keys")
            ta = f"CAST({quote_column(m['timestamp_column'], 'e')} AS TIMESTAMP)"
            tb = f"CAST({quote_column(b['timestamp_column'], 'b')} AS TIMESTAMP)"
            on = [f"{quote_column(y['model'], 'b')} = {quote_column(x['model'], 'e')}" for x, y in zip(ka, kb)]
            on.append(f"{tb} > {ta}")
            within = then.get("within") or {}
            if within.get("amount") not in (None, ""):
                on.append(f"{tb} <= {ta} + {self.interval(within['amount'], within.get('unit', 'day'))}")
            on += self._filters(b, "b", then.get("filter"), None, then.get("event_names"))
            kind = "LEFT SEMI JOIN" if then.get("did", True) else "LEFT ANTI JOIN"
            join = f" {kind} {source(b)} b ON {' AND '.join(on)}"
        cte = self._grouped(m, "e", "COUNT(*)", join, where)
        if n.get("did", True) is False:
            return self._membership(m, cte, "count", "equals", 0)
        freq = n.get("frequency") or {"operator": "gte", "value": 1}
        return self._membership(m, cte, "count", freq.get("operator", "gte"), freq.get("value", 1), freq.get("value2"))

    @staticmethod
    def _legacy_sequence(n: dict) -> dict:
        first, then = n.get("first") or {}, n.get("then") or {}
        return {"type": "event", "model_id": first.get("model_id"), "did": True,
                "event_names": first.get("event_names"), "filter": first.get("filter"),
                "time_window": n.get("time_window"), "frequency": {"operator": "gte", "value": 1},
                "then": {"did": n.get("did_then", True), "model_id": then.get("model_id"),
                         "event_names": then.get("event_names"), "filter": then.get("filter"),
                         "within": n.get("within")}}

    def audience(self, n: dict) -> str:
        if not self.load_audience:
            raise CompileError("Audience references are not available here")
        if self.depth >= MAX_AUDIENCE_DEPTH:
            raise CompileError("Audiences reference each other too deeply (circular reference?)")
        definition = self.load_audience(int(n.get("audience_id")))
        alias = f"p{self.depth + 1}"
        sub = Compiler(self.schema, self.as_of, self.load_audience, self.s, alias, self.depth + 1, self.null_negation)
        where = sub.node(definition)
        pk = quote_ident(self.parent["primary_key"])
        inner = f"SELECT {alias}.{pk} FROM {source(self.parent)} {alias} WHERE {where}"
        return f"{self.alias}.{pk} {'IN' if n.get('included', True) else 'NOT IN'} ({inner})"

    def split(self, n: dict) -> str:
        """Deterministic bucket 0-99 per member (stable per audience), then the group's
        percentage range. Each profile is assigned once, based on its primary key."""
        groups = n.get("groups") or []
        if sum(int(g.get("percent", 0)) for g in groups) != 100:
            raise CompileError("Split percentages must add up to 100")
        bucket = (f"pmod(xxhash64(CAST({quote_column(self.parent['primary_key'], self.alias)} AS STRING), "
                  f"'audience-{int(n['audience_id'])}'), 100)")
        start = 0
        for g in groups:
            end = start + int(g["percent"])
            if g["name"] == n.get("group"):
                return f"({bucket} >= {start} AND {bucket} < {end})"
            start = end
        raise CompileError(f"Unknown split group {n.get('group')!r}")


def trait_type(method: str, cfg: dict, compiler: Compiler) -> str:
    if method in ("aggregation", "count"):
        return "number"
    if method == "occurrence":
        try:
            return compiler.column(compiler.model(cfg.get("model_id")), cfg.get("column"))["type"]
        except CompileError:
            return "string"
    if method in ("sql_aggregation", "sql_formula"):
        return cfg.get("result_type", "string")
    return "other"
