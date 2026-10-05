FROM oven/bun:1.4.2 AS runtime
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000
# Nest escuta SIGTERM (enableShutdownHooks) e drena o consumidor SQS antes de sair.
STOPSIGNAL SIGTERM
CMD ["bun", "run", "src/main.ts"]
