"""Column privacy levels (field guard). Modeled on Hightouch's levels, simplified.

  unreviewed   default; usable in filters; only syncable when REQUIRE_APPROVED_FIELDS is off
  approved     usable everywhere
  sync_only    can be synced but hidden from filters and previews
  sync_blocked usable in filters/previews but can never be synced
  redacted     values masked in previews and suggestions; filterable and syncable
  blocked      hidden everywhere: no filters, previews, suggestions or syncs
"""
import os

LEVELS = ["unreviewed", "approved", "sync_only", "sync_blocked", "redacted", "blocked"]
MASK = "••••"


def require_approved() -> bool:
    return os.environ.get("REQUIRE_APPROVED_FIELDS", "true").lower() not in ("0", "false", "no")


def level(model, col: str) -> str:
    return (model.column_privacy or {}).get(col, "unreviewed")


def _cols(model, levels: set[str]) -> set[str]:
    return {c for c, lv in (model.column_privacy or {}).items() if lv in levels}


def no_filter_columns(model) -> set[str]:
    return _cols(model, {"blocked", "sync_only"})


def masked_columns(model) -> set[str]:
    return _cols(model, {"blocked", "sync_only", "redacted"})


def sync_problems(model, columns: list[str]) -> list[str]:
    """Reasons the given source columns can't be synced (empty list = all fine)."""
    out = []
    strict = require_approved()
    for c in columns:
        lv = level(model, c)
        if lv in ("blocked", "sync_blocked"):
            out.append(f"'{c}' is {lv.replace('_', '-')} and can't be synced")
        elif lv == "unreviewed" and strict:
            out.append(f"'{c}' hasn't been reviewed - set its privacy level to Approved on the Schema page")
    return out


def annotate(columns: list[dict], model) -> list[dict]:
    return [{**c, "privacy": level(model, c["name"])} for c in columns]
