"""App metadata store (SQLite). Holds connections, segments, syncs and run history."""
from datetime import datetime
from pathlib import Path

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

engine = create_engine(
    f"sqlite:///{DATA_DIR / 'app.db'}", connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Connection(Base):
    """A source (databricks) or destination (sailthru)."""

    __tablename__ = "connections"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))  # databricks | demo | sailthru
    role: Mapped[str] = mapped_column(String(16))  # source | destination
    name: Mapped[str] = mapped_column(String(128))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Model(Base):
    """A table exposed for segmentation. kind=parent is the audience entity (e.g. users);
    kind=related hangs off a parent through parent_key -> related_key (e.g. orders.user_id)."""

    __tablename__ = "models"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16))  # parent | related
    source_id: Mapped[int] = mapped_column(ForeignKey("connections.id"))
    table_name: Mapped[str] = mapped_column(String(256))
    primary_key: Mapped[str] = mapped_column(String(128), default="")
    email_column: Mapped[str] = mapped_column(String(128), default="")  # parent only
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("models.id"), nullable=True)
    parent_key: Mapped[str] = mapped_column(String(128), default="")  # column on the parent
    related_key: Mapped[str] = mapped_column(String(128), default="")  # column on this table
    cardinality: Mapped[str] = mapped_column(String(16), default="has_many")  # has_many | has_one | many_to_one
    description: Mapped[str] = mapped_column(Text, default="")
    primary_label: Mapped[str] = mapped_column(String(128), default="")
    secondary_label: Mapped[str] = mapped_column(String(128), default="")
    column_suggestions: Mapped[int] = mapped_column(Integer, default=0)
    timestamp_column: Mapped[str] = mapped_column(String(128), default="")  # event models
    event_type: Mapped[str] = mapped_column(String(64), default="")
    extra_keys: Mapped[list] = mapped_column(JSON, default=list)  # extra join pairs [[parent_col, related_col]]
    column_privacy: Mapped[dict] = mapped_column(JSON, default=dict)  # column -> privacy level
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Segment(Base):
    __tablename__ = "segments"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")
    model_id: Mapped[int] = mapped_column(ForeignKey("models.id"))
    filter: Mapped[dict] = mapped_column(JSON, default=dict)
    last_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Sync(Base):
    __tablename__ = "syncs"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    segment_id: Mapped[int] = mapped_column(ForeignKey("segments.id"))
    destination_id: Mapped[int] = mapped_column(ForeignKey("connections.id"))
    list_name: Mapped[str] = mapped_column(String(128), default="")
    mode: Mapped[str] = mapped_column(String(16), default="mirror")  # upsert | mirror (add_to_list only)
    mapping: Mapped[list] = mapped_column(JSON, default=list)  # [{source, target}]
    action: Mapped[str] = mapped_column(String(24), default="add_to_list")  # add_to_list | update_profile | set_vars
    match_key: Mapped[str] = mapped_column(String(16), default="email")  # Sailthru key: email | sid | extid
    match_column: Mapped[str] = mapped_column(String(128), default="")  # source column holding the identifier
    schedule: Mapped[dict] = mapped_column(JSON, default=dict)  # {type: manual|interval|daily, minutes, time}
    schedule_enabled: Mapped[int] = mapped_column(Integer, default=1)
    alerts: Mapped[dict] = mapped_column(JSON, default=dict)
    timeout_minutes: Mapped[int] = mapped_column(Integer, default=30)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SyncRun(Base):
    __tablename__ = "sync_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    sync_id: Mapped[int] = mapped_column(ForeignKey("syncs.id"))
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|success|failed
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    total: Mapped[int] = mapped_column(Integer, default=0)
    added: Mapped[int] = mapped_column(Integer, default=0)
    removed: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    dry_run: Mapped[int] = mapped_column(Integer, default=0)
    log: Mapped[str] = mapped_column(Text, default="")
    trigger: Mapped[str] = mapped_column(String(16), default="manual")  # manual | schedule
    error: Mapped[str] = mapped_column(Text, default="")
    flags: Mapped[str] = mapped_column(Text, default="")  # threshold warnings, newline separated
    matched: Mapped[int] = mapped_column(Integer, default=0)  # members returned by the segment


class SyncRejection(Base):
    """Rows the destination (or a pre-check) rejected, for the run's rejected-rows view."""

    __tablename__ = "sync_rejections"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("sync_runs.id"), index=True)
    identifier: Mapped[str] = mapped_column(String(320))
    reason: Mapped[str] = mapped_column(Text, default="")


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    sync_id: Mapped[int] = mapped_column(ForeignKey("syncs.id"), index=True)
    run_id: Mapped[int | None] = mapped_column(ForeignKey("sync_runs.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(24))  # failed | rejected | cancelled | timed_out | stale | threshold
    severity: Mapped[str] = mapped_column(String(12), default="warning")  # warning | critical
    message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SyncMember(Base):
    """Members pushed in the last successful run - lets 'mirror' mode compute removals."""

    __tablename__ = "sync_members"
    id: Mapped[int] = mapped_column(primary_key=True)
    sync_id: Mapped[int] = mapped_column(ForeignKey("syncs.id"), index=True)
    email: Mapped[str] = mapped_column(String(320))


MIGRATIONS = {
    "models": {
        "description": "TEXT DEFAULT ''",
        "primary_label": "VARCHAR(128) DEFAULT ''",
        "secondary_label": "VARCHAR(128) DEFAULT ''",
        "column_suggestions": "INTEGER DEFAULT 0",
        "timestamp_column": "VARCHAR(128) DEFAULT ''",
        "event_type": "VARCHAR(64) DEFAULT ''",
        "extra_keys": "JSON",
        "column_privacy": "JSON",
    },
    "syncs": {
        "action": "VARCHAR(24) DEFAULT 'add_to_list'",
        "match_key": "VARCHAR(16) DEFAULT 'email'",
        "match_column": "VARCHAR(128) DEFAULT ''",
        "schedule": "JSON",
        "schedule_enabled": "INTEGER DEFAULT 1",
        "alerts": "JSON",
        "timeout_minutes": "INTEGER DEFAULT 30",
    },
    "sync_runs": {
        "trigger": "VARCHAR(16) DEFAULT 'manual'",
        "error": "TEXT DEFAULT ''",
        "flags": "TEXT DEFAULT ''",
        "matched": "INTEGER DEFAULT 0",
    },
}


def init_db() -> None:
    Base.metadata.create_all(engine)
    with engine.begin() as c:  # tiny additive migration so existing dev data survives
        for table, cols in MIGRATIONS.items():
            have = {r[1] for r in c.exec_driver_sql(f"PRAGMA table_info({table})")}
            for col, ddl in cols.items():
                if col not in have:
                    c.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
