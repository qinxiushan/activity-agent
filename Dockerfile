FROM docker.m.daocloud.io/library/node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache bash su-exec wget \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001 -G nodejs

ENV NODE_ENV=production
ENV PORT=30142
ENV HOSTNAME=0.0.0.0

COPY public ./public
COPY .next/standalone ./
COPY .next/static ./.next/static
COPY db ./db
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && mkdir -p /home/nextjs/.pi/agent \
  && chown -R nextjs:nodejs /app /home/nextjs

EXPOSE 30142

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:30142/api/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
