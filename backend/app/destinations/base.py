"""Destination connector interface.

A destination declares one or more *sync types* (what is sent, e.g. Users or
Purchases). Each sync type declares its modes (how records are applied), the
identifiers it can match on, its field targets, sync-level options and the
delete behaviors it supports for records that leave the audience.

The sync engine hands connectors batches of rows shaped as
    {"id": <row primary key>, "match": <identifier value or None>, "fields": {<target>: value}}
and expects back a dict {row_id: error_message} for rows that were rejected.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field


@dataclass
class ConfigField:
    name: str
    label: str
    type: str = "text"  # text | password | number | textarea | select | column
    required: bool = True
    help: str = ""
    default: str | int | None = None
    options: list[dict] = field(default_factory=list)  # for select: [{"value", "label"}]
    modes: list[str] = field(default_factory=list)  # only shown for these modes (empty = all)
    secret: bool = False  # masked like a password when read back (e.g. a pasted JSON key)


@dataclass
class TargetField:
    name: str
    label: str
    required: bool = False


@dataclass
class Identifier:
    name: str
    label: str
    modes: list[str] = field(default_factory=list)  # empty = every mode


DELETE_BEHAVIOR_LABELS = {
    "do_nothing": "Do nothing",
    "clear": "Clear",
    "delete": "Delete",
    "remove": "Remove",
}


@dataclass
class SyncType:
    name: str
    label: str
    description: str
    modes: list[str]
    identifiers: list[Identifier] = field(default_factory=list)
    target_fields: list[TargetField] = field(default_factory=list)
    custom_fields: bool = False  # users may also type their own destination field names
    delete_behaviors: dict[str, str] = field(default_factory=dict)  # behavior -> description
    options: list[ConfigField] = field(default_factory=list)
    source: str = "audience"  # "audience" (one row per member) or "events" (rows of an event/related model)
    default_delete: str = "do_nothing"  # used when a sync doesn't choose one


MODE_LABELS = {"upsert": "Upsert", "update": "Update", "insert": "Insert", "add": "Add"}


class Destination:
    type: str = ""
    label: str = ""
    description: str = ""
    category: str = ""
    beta: bool = False
    config_fields: list[ConfigField] = []
    batch_size: int = 100

    # Single-sync-type destinations can keep using these shortcuts.
    target_fields: list[TargetField] = []
    custom_fields: bool = False
    supports_remove: bool = True

    def __init__(self, config: dict, context: dict | None = None):
        self.config = config
        self.context = context or {}
        self.debug_log: list[dict] = []

    def record(self, method: str, url: str, request, status: int | None, response) -> None:
        """Keep a sample of requests/responses for the run debugger (secrets are never logged)."""
        if len(self.debug_log) < DEBUG_SAMPLE:
            self.debug_log.append({"method": method, "url": url, "request": _clip(request),
                                   "status": status, "response": _clip(response)})

    # context helpers ---------------------------------------------------------
    @property
    def sync_type(self) -> str:
        return self.context.get("sync_type") or self.sync_types()[0].name

    @property
    def mode(self) -> str:
        return self.context.get("mode") or self.sync_types()[0].modes[0]

    @property
    def options(self) -> dict:
        return self.context.get("options") or {}

    @property
    def match_field(self) -> str | None:
        return self.context.get("match_field")

    # interface ---------------------------------------------------------------
    @classmethod
    def sync_types(cls) -> list[SyncType]:
        return [SyncType(
            name="default", label=cls.label, description=cls.description, modes=["upsert"],
            target_fields=cls.target_fields, custom_fields=cls.custom_fields or not cls.target_fields,
            delete_behaviors=({"do_nothing": "Leave them in the destination",
                               "remove": "Remove them from the destination"} if cls.supports_remove
                              else {"do_nothing": "Leave them in the destination"}),
        )]

    @classmethod
    def get_sync_type(cls, name: str | None) -> SyncType:
        types = cls.sync_types()
        for t in types:
            if t.name == name:
                return t
        if name in (None, "", "default"):
            return types[0]
        raise ValueError(f"{cls.label} has no sync type {name!r}")

    def batch_size_for_run(self) -> int:
        return self.batch_size

    def prepare(self) -> dict:
        """Runs before anything is sent. Return sync-option updates to save (e.g. the ID of a list/segment
        the connector just created), or {}."""
        return {}

    def test(self) -> str:
        """Check credentials; return a human-readable success message or raise."""
        return "OK"

    def upsert(self, rows: list[dict]) -> dict[str, str]:
        """Send new or changed rows (insert / update / upsert depending on mode)."""
        raise NotImplementedError

    def remove(self, rows: list[dict]) -> dict[str, str]:
        """Delete behavior 'remove' / 'delete' for rows that left the audience."""
        raise NotImplementedError

    def clear(self, rows: list[dict]) -> dict[str, str]:
        """Delete behavior 'clear': blank the mapped fields, keep the record."""
        raise NotImplementedError

    def close(self) -> None:
        pass

    @classmethod
    def describe(cls) -> dict:
        return {
            "type": cls.type,
            "label": cls.label,
            "description": cls.description,
            "category": cls.category,
            "beta": cls.beta,
            "config_fields": [asdict(f) for f in cls.config_fields],
            "sync_types": [asdict(t) for t in cls.sync_types()],
        }


DEBUG_SAMPLE = 50


def _clip(value, limit: int = 2000):
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


def fail_all(rows: list[dict], error: str) -> dict[str, str]:
    return {r["id"]: error for r in rows}
