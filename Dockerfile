FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/data \
    && chown -R app:app /app

USER app

EXPOSE 9471

CMD ["node", "server.js"]
