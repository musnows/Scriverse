FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=13210 \
    DATA_DIR=/app/.data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --chown=node:node src/public ./src/public

RUN mkdir -p /app/.data && chown node:node /app/.data

USER node

VOLUME ["/app/.data"]
EXPOSE 13210

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const port = process.env.PORT || 13210; fetch(`http://127.0.0.1:${port}/api/health`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/server.js"]
