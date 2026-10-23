FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY public ./public
COPY config/defaults.json ./config/defaults.json
RUN npm run data:validate && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATABASE_PATH=/app/storage/noetic-atlas.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/storage && chown node:node /app/storage
COPY --from=build /app/dist ./dist
COPY config/defaults.json ./config/defaults.json
USER node
EXPOSE 4317
CMD ["node", "dist/server/main.js"]
