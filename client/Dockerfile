# Build context is the repository root:  docker build -f client/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --workspace @stillnote/client --include-workspace-root=false
COPY client ./client
# Leave VITE_API_URL unset: the browser calls /api on the same origin and nginx proxies it.
RUN npm run build --workspace @stillnote/client

FROM nginx:1.27-alpine
# *.template files are rendered with environment variables at container start.
COPY client/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY client/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:4000
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
