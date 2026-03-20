FROM debian:bookworm-slim

# ── System deps: Chromium + Xvfb + VNC + noVNC + Node.js ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-sandbox \
    xvfb x11vnc fluxbox \
    novnc websockify \
    fonts-wqy-zenhei fonts-noto-cjk \
    procps curl ca-certificates \
    python3 python3-pip \
    gnupg \
    git jq ripgrep zip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Edge TTS (Microsoft free high-quality TTS, no API key needed)
RUN pip install --break-system-packages edge-tts

# Docker CLI (newer API than Debian docker.io) for sandbox docker-exec
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
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
RUN set -eux; \
    i=0; \
    until [ "$i" -ge 3 ]; do \
      npm ci --omit=dev --no-audit --no-fund && break; \
      i=$((i+1)); \
      echo "npm ci failed, retry $i/3"; \
      sleep 5; \
    done; \
    [ "$i" -lt 3 ]; \
    npm cache clean --force

COPY server.js ./
COPY public ./public
COPY lumigent ./lumigent
COPY collector ./collector
COPY security ./security
COPY tools ./tools
COPY routes ./routes
COPY middleware ./middleware
COPY templates ./templates
COPY services ./services

RUN mkdir -p /app/data && chown -R chrome:chrome /app/data

# ── Entrypoint ──
COPY entrypoint-combined.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /home/chrome/.chrome-profile
VOLUME /app/data

# Ports: 9471=LumiGate, 7900=noVNC (login)
EXPOSE 9471 7900

ENTRYPOINT ["/entrypoint.sh"]
