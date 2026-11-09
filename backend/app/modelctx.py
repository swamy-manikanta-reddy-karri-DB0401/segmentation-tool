"""Builds the compile context (columns + related models) for a parent model."""
from .connectors import get_source
from .db import Connection, Model
from .privacy import no_filter_columns
from .rules import Ctx


def model_ctx(db, model: Model, src=None) -> Ctx:
    src = src or get_source(db.get(Connection, model.source_id))
    ctx = Ctx(src.dialect, {c["name"]: c["category"] for c in src.columns(model.table_name)},
              no_filter=no_filter_columns(model))
    for rel in db.query(Model).filter_by(parent_id=model.id):
        rsrc = src if rel.source_id == model.source_id else get_source(db.get(Connection, rel.source_id))
        ctx.relations[rel.id] = {
            "name": rel.name,
            "kind": rel.kind,
            "table": rel.table_name,
            "columns": {c["name"]: c["category"] for c in rsrc.columns(rel.table_name)},
            "parent_key": rel.parent_key,
            "related_key": rel.related_key,
            "extra_keys": rel.extra_keys or [],
            "timestamp_column": rel.timestamp_column,
            "no_filter": sorted(no_filter_columns(rel)),
        }
    return ctx
