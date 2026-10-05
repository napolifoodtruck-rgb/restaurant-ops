#!/usr/bin/env bash
# Applies db/migrations in order to a throwaway PostgreSQL instance and runs db/schema_checks.sql.
# Needs PostgreSQL 16+ installed locally (initdb, pg_ctl, psql).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pg_bin="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")}"
work="$(mktemp -d)"
trap '"$pg_bin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

"$pg_bin/initdb" -D "$work/data" -U postgres -A trust >/dev/null
"$pg_bin/pg_ctl" -D "$work/data" -o "-k $work -c listen_addresses=''" -l "$work/log" -w start >/dev/null

run() { "$pg_bin/psql" -h "$work" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
for f in "$root"/db/migrations/*.sql; do run -f "$f"; done
run -f "$root/db/schema_checks.sql"
