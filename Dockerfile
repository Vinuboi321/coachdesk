# Node 22 for the built-in node:sqlite module — no native build, no
# compiler in the image, and a much smaller final layer.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so a code change doesn't invalidate the npm layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional 2>/dev/null || npm install --omit=dev --omit=optional

COPY server/ ./server/
COPY public/ ./public/

# The database lives on a mounted volume where one is available.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATABASE_FILE=/data/coachdesk.db

# Don't run as root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
