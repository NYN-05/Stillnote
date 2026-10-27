# Build context is the repository root:  docker build -f server/Dockerfile .
FROM node:26-slim AS deps
WORKDIR /app
# Workspace manifests only, so this layer is cached until dependencies change.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace @stillnote/server --include-workspace-root=false

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
# The unprivileged "node" user ships with the base image.
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.js"]
