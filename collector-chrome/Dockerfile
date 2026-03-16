FROM debian:bookworm-slim

# Install Chromium + Xvfb + VNC + noVNC
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-sandbox \
    xvfb x11vnc fluxbox \
    novnc websockify \
    fonts-wqy-zenhei fonts-noto-cjk \
    procps curl ca-certificates socat \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user, profile dir, and X11 socket dir
RUN useradd -m -s /bin/bash chrome \
    && mkdir -p /home/chrome/.chrome-profile \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    && chown -R chrome:chrome /home/chrome

RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html 2>/dev/null || true

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /home/chrome
VOLUME /home/chrome/.chrome-profile
EXPOSE 9222 5900 7900

ENTRYPOINT ["/entrypoint.sh"]
