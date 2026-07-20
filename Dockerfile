FROM docker.m.daocloud.io/library/node:22-alpine AS deps
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

FROM docker.m.daocloud.io/library/node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM docker.m.daocloud.io/library/node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache bash su-exec wget \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001 -G nodejs

ENV NODE_ENV=production
ENV PORT=30142
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/db ./db
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && mkdir -p /home/nextjs/.pi/agent \
  && chown -R nextjs:nodejs /app /home/nextjs

EXPOSE 30142

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:30142/api/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
