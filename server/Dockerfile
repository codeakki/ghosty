# Ghosty server image. Build from the repo root so the terminal dashboard is included:
#   docker build -f server/Dockerfile -t ghosty-server .
# Secrets come from the environment at run time (never baked into the image).

FROM node:22-slim AS terminal
WORKDIR /app/terminal
COPY terminal/package.json terminal/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY terminal/ ./
RUN npm run build

FROM node:22-slim AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY server/package.json ./
COPY server/public ./public
COPY --from=terminal /app/terminal/dist /app/terminal/dist
RUN mkdir -p .ghosty && chown -R node:node /app/server/.ghosty
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
