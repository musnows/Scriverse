# syntax=docker/dockerfile:1

# 基础镜像按多架构索引固定，升级 Node 时需同步更新摘要。
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e

FROM ${NODE_IMAGE} AS dependency-manifests

WORKDIR /manifests

COPY scripts/normalize-docker-package-manifests.mjs ./normalize-package-manifests.mjs
COPY package.json package-lock.json ./
RUN node ./normalize-package-manifests.mjs package.json package-lock.json

FROM ${NODE_IMAGE} AS production-dependencies

WORKDIR /app

COPY --from=dependency-manifests /manifests/package.json /manifests/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev --ignore-scripts
RUN mkdir -p /runtime-data

FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY --from=dependency-manifests /manifests/package.json /manifests/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM ${RUNTIME_IMAGE} AS runtime

WORKDIR /app

COPY --from=build /usr/local/bin/node /nodejs/bin/node
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY --chown=1000:1000 --from=production-dependencies /runtime-data /app/.data

ENV NODE_ENV=production \
    SCRIVERSE_RUNTIME=container \
    LOG_LEVEL=info \
    TZ=Asia/Shanghai \
    HOST=0.0.0.0 \
    PORT=13210 \
    DATA_DIR=/app/.data

USER 1000:1000

VOLUME ["/app/.data"]
EXPOSE 13210

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const port = process.env.PORT || 13210; fetch(`http://127.0.0.1:${port}/api/health`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/server.js"]
