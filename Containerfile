FROM docker.io/oven/bun:1.4.2 AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM docker.io/oven/bun:1.4.2

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV BUCKETS_CONFIG=/app/config.toml \
    BUCKETS_STATE_DIR=/app/state

CMD ["bun", "run", "src/main.ts"]
