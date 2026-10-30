"""Set up Snowflake, load Pomona OpenStreetMap businesses, and call the search.

Usage (from the local-quest folder):
    snowflake/.venv/bin/python snowflake/scripts/lq.py <command>

Commands, in first-run order:
    check                     connect and print account/user/role/region
    setup [--reset]           roles, warehouse, database, tables (--reset drops the database first)
    deploy                    build + upload the Python package, create UDF and procedure
    load                      fetch Pomona OSM places + addresses, upload, parse hours, embed
    call REQUEST.json "ADDRESS" [--out FILE] [--role LQ_APP_RO]
                              run the API's exact call and print the result:
                              CALL LOCAL_QUEST.APP.FIND_QUEST_LOCATIONS(PARSE_JSON(<json>), <address>)

Connection settings come from environment variables or the project's main .env
(local-quest/.env): SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER (login
name), SNOWFLAKE_PRIVATE_KEY_PATH, optional SNOWFLAKE_PRIVATE_KEY_PASSPHRASE, and
SNOWFLAKE_DATABASE (default LOCAL_QUEST). Admin commands always use role LQ_OWNER
and warehouse LQ_WH, not the API's SNOWFLAKE_ROLE.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
sys.path.insert(0, str(ROOT / "python"))
from lq_snowflake import settings  # noqa: E402

IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")


def load_env():
    env_file = ROOT.parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                value = value.split(" #", 1)[0].strip().strip('"').strip("'")  # inline comment
                if value:
                    os.environ.setdefault(key.strip(), value)


def connect():
    import snowflake.connector

    missing = [k for k in ("SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PRIVATE_KEY_PATH")
               if not os.environ.get(k)]
    if missing:
        sys.exit(f"missing settings: {', '.join(missing)} (see local-quest/.env.example)")
    params = {
        "account": os.environ["SNOWFLAKE_ACCOUNT"],
        "user": os.environ["SNOWFLAKE_USER"],
        "authenticator": "SNOWFLAKE_JWT",
        "private_key_file": os.path.expanduser(os.environ["SNOWFLAKE_PRIVATE_KEY_PATH"]),
        "login_timeout": 60,
        "network_timeout": 300,
        "enable_server_session_keep_alive_auto_detection": False,
    }
    if os.environ.get("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"):
        params["private_key_file_pwd"] = os.environ["SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"]
    return snowflake.connector.connect(**params)


def lq_db():
    name = os.environ.get("SNOWFLAKE_DATABASE") or "LOCAL_QUEST"
    if not IDENTIFIER.match(name):
        sys.exit("SNOWFLAKE_DATABASE must be a plain identifier")
    return name


def use_project(cur, role="LQ_OWNER"):
    cur.execute(f"USE ROLE {role}")
    cur.execute("USE WAREHOUSE LQ_WH")
    cur.execute(f"USE DATABASE {lq_db()}")
    cur.execute("USE SCHEMA APP")
    cur.execute("SET lq_db = %s", (lq_db(),))


def run_file(conn, name):
    print(f"-- running sql/{name}")
    for cursor in conn.execute_string((ROOT / "sql" / name).read_text(), remove_comments=True):
        lines = [ln for ln in (cursor.query or "").splitlines() if not ln.strip().startswith("--")]
        if cursor.description and "\n".join(lines).lstrip().upper().startswith(("SELECT", "WITH")):
            print("   " + " | ".join(c[0] for c in cursor.description))
            for row in cursor.fetchall():
                print("   " + " | ".join("" if v is None else str(v) for v in row))


def put(cur, local, stage, compress=True):
    cur.execute(f"PUT 'file://{Path(local).resolve()}' {stage} "
                f"AUTO_COMPRESS={'TRUE' if compress else 'FALSE'} OVERWRITE=TRUE")
    print(f"-- uploaded {Path(local).name} to {stage}")


def cmd_check(conn, args):
    cur = conn.cursor()
    cur.execute("SELECT CURRENT_ACCOUNT(), CURRENT_USER(), CURRENT_ROLE(), CURRENT_REGION()")
    print("connected: account={} user={} role={} region={}".format(*cur.fetchone()))


def cmd_setup(conn, args):
    cur = conn.cursor()
    cur.execute("USE ROLE ACCOUNTADMIN")
    if args.reset:
        cur.execute(f"DROP DATABASE IF EXISTS {lq_db()}")
        print(f"-- dropped database {lq_db()}")
    cur.execute("SET lq_db = %s", (lq_db(),))
    run_file(conn, "01_setup.sql")
    use_project(cur)
    run_file(conn, "02_tables.sql")


def cmd_deploy(conn, args):
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_package.py")], check=True)
    cur = conn.cursor()
    use_project(cur)
    put(cur, BUILD / "lq_snowflake.zip", "@APP.CODE", compress=False)
    run_file(conn, "03_functions.sql")


def cmd_load(conn, args):
    fetch = [sys.executable, str(ROOT / "scripts" / "osm_fetch.py")]
    places = BUILD / "osm_pomona_places.ndjson"
    addresses = BUILD / "osm_pomona_addresses.ndjson"
    subprocess.run(fetch + ["--out", str(places)], check=True)
    subprocess.run(fetch + ["--addresses", "--out", str(addresses)], check=True)
    cur = conn.cursor()
    use_project(cur)
    cur.execute("REMOVE @APP.OSM")
    put(cur, places, "@APP.OSM")
    put(cur, addresses, "@APP.OSM")
    cur.execute("SET embed_model = %s", (settings.EMBED_MODEL,))
    run_file(conn, "04_load.sql")


def cmd_call(conn, args):
    request_text = Path(args.request).read_text()
    json.loads(request_text)  # fail early on malformed JSON
    cur = conn.cursor()
    use_project(cur, role=args.role)
    cur.execute(f"CALL {lq_db()}.APP.FIND_QUEST_LOCATIONS(PARSE_JSON(%s), %s)",
                (request_text, args.address))
    output = json.dumps(json.loads(cur.fetchone()[0]), indent=2, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(output + "\n")
        print(f"wrote {args.out}")
    else:
        print(output)


def main():
    parser = argparse.ArgumentParser(description="Local Quest Snowflake runner")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    setup = sub.add_parser("setup")
    setup.add_argument("--reset", action="store_true", help="drop and recreate the database")
    sub.add_parser("deploy")
    sub.add_parser("load")
    call = sub.add_parser("call")
    call.add_argument("request")
    call.add_argument("address")
    call.add_argument("--out")
    call.add_argument("--role", default="LQ_OWNER", choices=["LQ_OWNER", "LQ_APP_RO"])
    args = parser.parse_args()

    load_env()
    handlers = {"check": cmd_check, "setup": cmd_setup, "deploy": cmd_deploy,
                "load": cmd_load, "call": cmd_call}
    conn = connect()
    try:
        handlers[args.command](conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
