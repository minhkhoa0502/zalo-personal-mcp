# Base image is overridable so you can point at a private mirror/registry
# (e.g. NODE_IMAGE=reg.mini.dev/node:24.18.0). Default is public Docker Hub so
# the repo builds for anyone. Node 24 = current Active LTS (EOL Apr 2028).
ARG NODE_IMAGE=node:24-alpine

# --- build stage: compile TypeScript ---------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs exactly the pinned, integrity-checked lockfile.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: only prod deps + compiled output -----------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Session/QR live on a mounted volume; make it writable by the non-root user.
RUN mkdir -p /app/.zalo && chown -R node:node /app/.zalo
USER node

# Default: run the MCP server (stdio). Use CMD (not ENTRYPOINT) so it can be
# overridden, e.g. `docker compose run zalo-mcp node dist/login.js`.
CMD ["node", "dist/index.js"]
