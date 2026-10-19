#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ $# -ne 1 ]]; then
    echo "Usage: ./auth.sh <account-id>" >&2
    exit 1
fi
if [[ ! -f config.toml ]]; then
    echo "Copy config.example.toml to config.toml and configure Google first" >&2
    exit 1
fi

mkdir -p state google
chmod 0700 state google
export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
auth_port="${BUCKETS_AUTH_PORT:-8787}"

podman-compose -f compose.yml build buckets
podman-compose -f compose.yml run --rm --no-deps \
    --publish "127.0.0.1:${auth_port}:${auth_port}" \
    -e BUCKETS_AUTH_HOST=0.0.0.0 \
    -e "BUCKETS_AUTH_PORT=${auth_port}" \
    buckets bun run src/auth.ts "$1"
