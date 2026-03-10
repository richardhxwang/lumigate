FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY node_modules ./node_modules
RUN npm ci --omit=dev || true

COPY server.js ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
