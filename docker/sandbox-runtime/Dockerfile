FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    unzip \
    wget \
    xz-utils \
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
  && ln -sf /usr/bin/pip3 /usr/local/bin/pip

# Install doc-gen libraries (ExcelJS, docx, pptxgenjs) so the sandbox
# can generate Office documents without requiring the dedicated doc-gen container.
RUN npm install --global exceljs@^4.4.0 docx@^9.0.2 pptxgenjs@^3.12.0 \
  && ln -sf /usr/local/lib/node_modules /workspace/node_modules 2>/dev/null || true

# Make the global packages resolvable from /workspace scripts via NODE_PATH.
ENV NODE_PATH=/usr/local/lib/node_modules

WORKDIR /workspace
