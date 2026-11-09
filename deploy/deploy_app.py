"""Package MediaMint CDP as a Databricks App and deploy it.

Usage (from the repo root, with DATABRICKS_HOST / DATABRICKS_TOKEN in .env or the environment):
    python deploy/deploy_app.py                # package, upload, deploy
    python deploy/deploy_app.py --package-only # just build ./build/databricks-app

Build the frontend first (frontend/dist). Settings below can be overridden with environment variables.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "databricks-app"

APP_NAME = os.environ.get("CDP_APP_NAME", "mediamint-cdp")
SETTINGS = {
    # Lakebase Autoscaling project that stores the app's metadata
    "LAKEBASE_ENDPOINT": os.environ.get("CDP_LAKEBASE_ENDPOINT", "projects/mediamint-cdp/branches/production/endpoints/primary"),
    "PGHOST": os.environ.get("CDP_PGHOST", "ep-restless-mouse-e7ifptx8.database.centralindia.azuredatabricks.net"),
    "PGDATABASE": "databricks_postgres",
    "PGSSLMODE": "require",
    "PGSCHEMA": "cdp",
    # Databricks users or groups that are always Platform Admins (comma separated)
    "CDP_PLATFORM_ADMINS": os.environ.get("CDP_PLATFORM_ADMINS", "manikanta.karri@sureshgarapatidatabeat.onmicrosoft.com"),
    # Links in alert notifications point here
    "CDP_APP_URL": os.environ.get("CDP_APP_URL", "https://mediamint-cdp-7405615965667597.17.azure.databricksapps.com"),
    # Postgres roles that may read/write the app's tables (DBAs, data migration)
    "PG_GRANT_TO": os.environ.get("CDP_PG_GRANT_TO", "manikanta.karri@sureshgarapatidatabeat.onmicrosoft.com"),
}
REQUIREMENTS = """fastapi>=0.115
uvicorn[standard]>=0.30
httpx>=0.27
python-dotenv>=1.0
croniter>=2.0
python-liquid>=1.12
pyjwt[crypto]>=2.8
psycopg[binary,pool]>=3.2
databricks-sdk>=0.81.0
"""


def app_yaml() -> str:
    env = "\n".join(f"  - name: {k}\n    value: \"{v}\"" for k, v in SETTINGS.items())
    # UVICORN_HOST / UVICORN_PORT are set by Databricks Apps to the port the app must listen on.
    return f"""command: ["uvicorn", "app.main:app", "--app-dir", "backend"]
env:
{env}
"""


def package() -> Path:
    dist = ROOT / "frontend" / "dist"
    if not (dist / "index.html").exists():
        sys.exit("frontend/dist is missing — build the frontend first")
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(ROOT / "backend" / "app", OUT / "backend" / "app",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(dist, OUT / "frontend" / "dist")
    (OUT / "app.yaml").write_text(app_yaml(), encoding="utf-8")
    (OUT / "requirements.txt").write_text(REQUIREMENTS, encoding="utf-8")
    return OUT


def run(*args: str) -> str:
    print("$", " ".join(args))
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr or r.stdout)
    return r.stdout


def deploy(src: Path) -> None:
    me = run("databricks", "current-user", "me", "-o", "json")
    import json
    user = json.loads(me)["userName"]
    target = f"/Workspace/Users/{user}/apps/{APP_NAME}"
    run("databricks", "workspace", "mkdirs", target)
    run("databricks", "workspace", "import-dir", str(src), target, "--overwrite")
    print(run("databricks", "apps", "deploy", APP_NAME, "--source-code-path", target, "-o", "json")[-600:])


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass
    out = package()
    print("packaged", out)
    if "--package-only" not in sys.argv:
        deploy(out)
