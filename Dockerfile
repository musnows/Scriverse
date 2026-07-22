# syntax=docker/dockerfile:1

# 基础镜像按多架构索引固定，升级 Node 时需同步更新摘要。
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

FROM ${NODE_IMAGE} AS dependency-manifests

WORKDIR /manifests

COPY scripts/normalize-docker-package-manifests.mjs ./normalize-package-manifests.mjs
COPY package.json package-lock.json ./
RUN node ./normalize-package-manifests.mjs package.json package-lock.json

FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY --from=dependency-manifests /manifests/package.json /manifests/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    LOG_LEVEL=info \
    HOST=0.0.0.0 \
    PORT=13210 \
    DATA_DIR=/app/.data

WORKDIR /app

RUN mkdir -p /app/.data && chown node:node /app/.data

COPY --from=dependency-manifests /manifests/package.json /manifests/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev

COPY --chown=node:node src/public ./src/public
COPY --from=build /app/dist ./dist

COPY package.json package-lock.json ./

USER node

VOLUME ["/app/.data"]
EXPOSE 13210

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const port = process.env.PORT || 13210; fetch(`http://127.0.0.1:${port}/api/health`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/server.js"]
