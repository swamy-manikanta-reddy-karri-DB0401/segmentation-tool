"""Advanced field mapper.

Mapping entry:
  {"target": "...", "type": "column" | "static" | "variable" | "template",
   "source": "<column>",                      # column
   "value": ..., "value_type": "string|number|boolean|null",   # static
   "variable": "model-id|model-name|current-timestamp|sync-id|sync-run-id",   # variable
   "template": "{{ row.first_name | upcase }}",                # Liquid template
   "null_behavior": "always" | "skip_nulls"}   # 'always' (default) sends nulls; 'skip_nulls' drops the field

Column values come from the warehouse (and are part of change detection). Templates can read
any column via `row.<col>` / `row['<col>']`; the columns they reference are fetched too.
Template filters follow Hightouch's documented custom functions where they apply.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
from datetime import datetime, timezone

from liquid import Environment
from liquid.exceptions import LiquidError

TEMPLATE_COLUMN_RE = re.compile(r"row(?:\.([A-Za-z_][\w.]*)|\[\s*['\"]([^'\"]+)['\"]\s*\])")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
VARIABLES = ("model-id", "model-name", "current-timestamp", "sync-id", "sync-run-id")


class RowRejected(Exception):
    """Raised by template functions that reject a row (includes, regex_test, validate_email)."""


def _cast(value, to):
    if value is None:
        return None
    if to == "number":
        f = float(value)
        return int(f) if f.is_integer() else f
    if to == "boolean":
        return str(value).lower() in ("true", "1", "yes", "y")
    return str(value)


def _includes(value, needle):
    if needle not in (value or ""):
        raise RowRejected(f"value does not include {needle!r}")
    return value


def _regex_test(value, pattern):
    if not re.search(pattern, str(value or "")):
        raise RowRejected(f"value does not match /{pattern}/")
    return value


def _validate_email(value):
    if not EMAIL_RE.match(str(value or "")):
        raise RowRejected(f"invalid email {value!r}")
    return value


def _to_unix(value):
    if value in (None, ""):
        return None
    return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())


def _to_date(value):
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()


env = Environment()
env.add_filter("sha256", lambda v: hashlib.sha256(str(v).encode()).hexdigest() if v is not None else None)
env.add_filter("sha512", lambda v: hashlib.sha512(str(v).encode()).hexdigest() if v is not None else None)
env.add_filter("md5", lambda v: hashlib.md5(str(v).encode()).hexdigest() if v is not None else None)
env.add_filter("b64_encode", lambda v: base64.b64encode(str(v).encode()).decode() if v is not None else None)
env.add_filter("b64_decode", lambda v: base64.b64decode(str(v)).decode() if v is not None else None)
env.add_filter("cast", _cast)
env.add_filter("includes", _includes)
env.add_filter("regex_replace", lambda v, pattern, repl="": re.sub(pattern, repl, str(v)) if v is not None else None)
env.add_filter("regex_test", _regex_test)
env.add_filter("validate_email", _validate_email)
env.add_filter("null_if_empty", lambda v: None if v in ("", [], {}) else v)
env.add_filter("parse", lambda v: json.loads(v) if isinstance(v, str) else v)
env.add_filter("json_construct", lambda v: json.dumps(v))
env.add_filter("to_unix", _to_unix)
env.add_filter("to_date", _to_date)
env.add_filter("push", lambda arr, item: [*(arr or []), item])

_cache: dict[str, object] = {}


def template_columns(template: str) -> set[str]:
    return {a or b for a, b in TEMPLATE_COLUMN_RE.findall(template or "")}


def kind(m: dict) -> str:
    return m.get("type") or "column"


def render(template: str, row: dict, context: dict):
    t = _cache.get(template)
    if t is None:
        try:
            t = env.from_string(template)
        except LiquidError as e:
            raise ValueError(f"Template error: {e}")
        _cache[template] = t
    try:
        out = t.render(row=row, context=context, **row)
    except RowRejected:
        raise
    except LiquidError as e:
        raise RowRejected(f"template error: {e}")
    out = out.strip()
    return None if out == "" else out


def static_value(m: dict):
    vt = m.get("value_type", "string")
    if vt == "null":
        return None
    return _cast(m.get("value"), vt)


def variable(name: str, context: dict):
    return {
        "model-id": context.get("model_id"),
        "model-name": context.get("model_name"),
        "current-timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sync-id": context.get("sync_id"),
        "sync-run-id": context.get("run_id"),
    }.get(name)


def finalize(mapping: list[dict], fields: dict, raw: dict, context: dict) -> dict:
    """Build the destination record from warehouse values (`fields` for column mappings,
    `raw` for template inputs) plus static values, variables and templates."""
    out = {}
    for m in mapping:
        k = kind(m)
        if k == "column":
            value = fields.get(m["target"])
        elif k == "static":
            value = static_value(m)
        elif k == "variable":
            value = variable(m.get("variable"), context)
        else:
            value = render(m.get("template", ""), raw, context)
        if value is None and m.get("null_behavior") == "skip_nulls":
            continue
        out[m["target"]] = value
    return out
