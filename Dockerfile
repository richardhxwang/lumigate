FROM debian:bookworm-slim

# ── System deps: Chromium + Xvfb + VNC + noVNC + Node.js ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-sandbox \
    xvfb x11vnc fluxbox \
    novnc websockify \
    fonts-wqy-zenhei fonts-noto-cjk \
    procps curl ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Node.js 20 (official nodesource)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Chrome user + dirs ──
RUN useradd -m -s /bin/bash chrome \
    && mkdir -p /home/chrome/.chrome-profile \
    && mkdir -p /home/chrome/.cache /home/chrome/.local/share /home/chrome/.config/chromium \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    && chown -R chrome:chrome /home/chrome

RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html 2>/dev/null || true

# ── Node.js app ──
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY public ./public
COPY lumigent ./lumigent
COPY collector ./collector
COPY security ./security
COPY tools ./tools
COPY routes ./routes
COPY middleware ./middleware
COPY templates ./templates

RUN mkdir -p /app/data && chown -R chrome:chrome /app/data

# ── Entrypoint ──
COPY entrypoint-combined.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /home/chrome/.chrome-profile
VOLUME /app/data

# Ports: 9471=LumiGate, 7900=noVNC (login)
EXPOSE 9471 7900

ENTRYPOINT ["/entrypoint.sh"]
