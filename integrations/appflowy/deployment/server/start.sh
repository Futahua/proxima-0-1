#!/bin/bash
set -euo pipefail
cd /opt/proxima-appflowy
if ! test -f .env; then python3 configure.py; fi
service docker start >/dev/null
docker compose up -d --wait --wait-timeout 240 postgres redis minio gotrue appflowy_cloud appflowy_worker appflowy_search admin_frontend appflowy_web nginx
docker compose ps --format json
