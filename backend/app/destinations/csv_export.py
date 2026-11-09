from __future__ import annotations

import csv
import re
from datetime import datetime

from .. import config
from .base import ConfigField, Destination


class CsvExport(Destination):
    type = "csv"
    label = "CSV file export"
    description = "Write each run's changes to a CSV file (one row per add / change / removal)."
    category = "Files"
    config_fields = [
        ConfigField("folder", "Folder name", help="Files are written to data/exports/<folder>/", default="exports"),
    ]
    batch_size = 5000

    def __init__(self, config_, context=None):
        super().__init__(config_, context)
        folder = re.sub(r"[^A-Za-z0-9_\-]", "_", config_.get("folder") or "exports")
        self.dir = config.EXPORT_DIR / folder
        self.dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.path = self.dir / f"sync{self.context.get('sync_id', '')}_run{self.context.get('run_id', '')}_{stamp}.csv"
        self._file = None
        self._writer = None
        self._fields: list[str] | None = None

    def _write(self, action: str, rows: list[dict]) -> dict[str, str]:
        if not rows:
            return {}
        if self._writer is None:
            self._fields = list(rows[0]["fields"].keys())
            self._file = open(self.path, "w", newline="", encoding="utf-8")
            self._writer = csv.writer(self._file)
            self._writer.writerow(["action", "id", *self._fields])
        for r in rows:
            self._writer.writerow([action, r["id"], *[r["fields"].get(f) for f in self._fields]])
        return {}

    def test(self) -> str:
        return f"Files will be written to {self.dir}"

    def upsert(self, rows):
        return self._write("upsert", rows)

    def remove(self, rows):
        return self._write("remove", rows)

    def close(self):
        if self._file:
            self._file.close()
