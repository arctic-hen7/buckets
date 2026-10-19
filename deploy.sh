#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f config.toml ]]; then
    cp config.example.toml config.toml
    echo "Created config.toml; configure accounts, tags, and Google credentials before deploying"
    exit 1
fi

if [[ ! -f .env && -z "${TYPESAFE_API_KEY:-}" ]]; then
    cp .env.example .env
    echo "Created .env; add TYPESAFE_API_KEY before deploying"
    exit 1
fi

mkdir -p state google
chmod 0700 state google
chmod 0600 config.toml
if [[ -f .env ]]; then chmod 0600 .env; fi

export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"

podman-compose -f compose.yml build buckets
podman-compose -f compose.yml run --rm --no-deps buckets bun run src/main.ts --check
podman-compose -f compose.yml run --rm --no-deps buckets bun -e \
    'if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY in .env or the environment")'
podman-compose -f compose.yml up -d buckets
echo "Buckets is running; follow logs with: podman-compose logs -f buckets"
