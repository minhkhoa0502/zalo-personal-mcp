# --- build stage: compile TypeScript ---------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs exactly the pinned, integrity-checked lockfile.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: only prod deps + compiled output -----------------------
FROM node:22-alpine AS runtime
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
