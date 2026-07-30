# All-in-one Dockerfile for Inker
# Bundles: frontend (nginx), backend (bun/nestjs). Data lives in a single SQLite file.

# =============================================================================
# Stage 1: Build frontend
# =============================================================================
FROM oven/bun:1-alpine AS frontend-builder

WORKDIR /app

COPY frontend/package.json frontend/bun.lock* ./
RUN bun install --frozen-lockfile

COPY frontend/ .
RUN bun run build

# =============================================================================
# Stage 2: Install backend production dependencies
# =============================================================================
FROM oven/bun:1-slim AS backend-install

WORKDIR /app

# Node.js binary for Prisma generate (bun segfaults with Prisma CLI)
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/bun.lock* ./
COPY backend/prisma ./prisma/

# Install all deps → generate prisma → reinstall production-only → prune
RUN bun install --frozen-lockfile && \
    node ./node_modules/prisma/build/index.js generate && \
    cp -r node_modules/.prisma /tmp/.prisma && \
    rm -rf node_modules && \
    bun install --production --frozen-lockfile && \
    # Merge generated clients into node_modules/.prisma (copy CONTENTS, not the dir, so we
    # don't nest as .prisma/.prisma when the production install already created .prisma).
    mkdir -p node_modules/.prisma && cp -r /tmp/.prisma/. node_modules/.prisma/ && \
    rm -rf /tmp/.prisma \
    node_modules/typescript \
    node_modules/@types && \
    # Prune unnecessary files from production node_modules
    find node_modules \( \
        -name "*.md" -o -name "*.map" -o -name "CHANGELOG*" -o \
        -name "README*" -o -name "LICENSE*" -o -name "*.d.ts" -o \
        -name "*.test.*" -o -name "*.spec.*" -o \
        -name "__tests__" -o -name "docs" -o -name ".github" -o \
        -name "example" -o -name "examples" -o -name ".npmignore" -o \
        -name "tsconfig.json" -o -name ".eslintrc*" -o -name ".prettierrc*" \
    \) -exec rm -rf {} + 2>/dev/null || true && \
    # Remove swagger UI (not needed in production)
    rm -rf node_modules/swagger-ui-dist && \
    # Remove musl variants of sharp (only glibc needed on Debian)
    rm -rf node_modules/@img/sharp-libvips-linuxmusl-x64 \
           node_modules/@img/sharp-linuxmusl-x64

# =============================================================================
# Stage 3: Build backend
# =============================================================================
FROM oven/bun:1-slim AS backend-builder

WORKDIR /app

COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/bun.lock* ./
RUN bun install --frozen-lockfile

COPY backend/prisma ./prisma/
RUN node ./node_modules/prisma/build/index.js generate

COPY backend/ .
RUN bun run build

# =============================================================================
# Stage 4: Production (all-in-one)
# =============================================================================
FROM debian:trixie-slim AS production

ARG S6_OVERLAY_VERSION=3.2.1.0
# Provided automatically by `docker buildx` (amd64 | arm64). Falls back to the build host's
# Debian arch so a plain `docker build` also works.
ARG TARGETARCH

# Install all system packages in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Nginx
    nginx \
    # Chrome headless shell dependencies
    wget ca-certificates openssl unzip \
    fonts-liberation fonts-symbola fonts-noto-cjk fontconfig \
    libnss3 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 \
    libgbm1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libasound2t64 libcups2t64 libatk1.0-0t64 libnspr4 libdbus-1-3 \
    # s6-overlay dependencies
    xz-utils \
    && \
    # Resolve target arch (buildx provides TARGETARCH; fall back to host arch for plain builds)
    TARGET_ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    # Install the headless browser per architecture, symlinked to a fixed path so the rest of
    # the image (and PUPPETEER_EXECUTABLE_PATH) is arch-agnostic.
    if [ "$TARGET_ARCH" = "arm64" ]; then \
        # chrome-for-testing has no arm64 build — use the distro Chromium (has arm64)
        apt-get install -y --no-install-recommends chromium && \
        ln -sf "$(command -v chromium)" /usr/local/bin/inker-chromium; \
    else \
        # x86: minimal chrome-headless-shell from chrome-for-testing (unchanged path)
        CHROME_VERSION=$(wget -qO- "https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE") && \
        wget -q "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip" -O /tmp/chrome.zip && \
        unzip /tmp/chrome.zip -d /opt/ && \
        chmod +x /opt/chrome-headless-shell-linux64/chrome-headless-shell && \
        rm /tmp/chrome.zip && \
        # Strip Chrome: remove GPU libs (--disable-gpu), keep locale packs for Unicode/CJK shaping
        rm -f /opt/chrome-headless-shell-linux64/libEGL.so \
              /opt/chrome-headless-shell-linux64/libGLESv2.so \
              /opt/chrome-headless-shell-linux64/libvk_swiftshader.so \
              /opt/chrome-headless-shell-linux64/libvulkan.so.1 \
              /opt/chrome-headless-shell-linux64/vk_swiftshader_icd.json \
              /opt/chrome-headless-shell-linux64/LICENSE.headless_shell && \
        ln -sf /opt/chrome-headless-shell-linux64/chrome-headless-shell /usr/local/bin/inker-chromium; \
    fi && \
    # Install s6-overlay (arch-specific tarball)
    case "$TARGET_ARCH" in arm64) S6_ARCH=aarch64 ;; *) S6_ARCH=x86_64 ;; esac && \
    wget -q "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" -O /tmp/s6-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-noarch.tar.xz && \
    wget -q "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" -O /tmp/s6-arch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-arch.tar.xz && \
    rm /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz && \
    # Remove build-only tools normally
    apt-get purge -y unzip xz-utils wget && apt-get autoremove -y && \
    # Force-remove transitive deps not needed at runtime (amd64 ONLY). The stripped
    # chrome-headless-shell doesn't use these, but distro Chromium on arm64 depends on
    # avahi/llvm/etc. at runtime — purging them there breaks Chromium (libavahi-common.so.3).
    if [ "$TARGET_ARCH" != "arm64" ]; then \
      dpkg --purge --force-depends \
      libllvm19 libz3-4 libperl5.40 perl perl-modules-5.40 \
      libavahi-client3 libavahi-common-data libavahi-common3 \
      libelf1t64 \
      2>/dev/null || true; \
    fi && \
    rm -rf /var/lib/apt/lists/* /var/log/dpkg.log /var/log/apt && \
    # Remove unused data (keep locales and i18n for Unicode/CJK support)
    rm -rf /usr/share/doc /usr/share/man \
           /usr/share/info /usr/share/lintian /usr/share/X11/xkb \
           /var/cache/debconf/*-old

# Install Bun runtime (copy from build image)
COPY --from=oven/bun:1-slim /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Node.js binary for Prisma CLI (Bun's baseline mode crashes on non-AVX2 hardware)
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

# Puppeteer configuration — fixed symlink resolves to the right browser per architecture
# (chrome-headless-shell on amd64, distro chromium on arm64; both linked in the layer above)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/inker-chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Application environment defaults
# The database is a single SQLite file on the uploads volume — no external DB required.
ENV NODE_ENV=production \
    PORT=3002 \
    DATABASE_URL=file:/app/uploads/inker.db \
    ADMIN_PIN="1111" \
    CORS_ORIGINS=* \
    LOG_LEVEL=info

# Set up application directory
WORKDIR /app

# Copy backend production dependencies
COPY --from=backend-install /app/node_modules ./node_modules

# Copy Prisma schema and generated client
COPY backend/prisma ./prisma/
COPY --from=backend-install /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-install /app/node_modules/@prisma ./node_modules/@prisma

# Copy backend build
COPY --from=backend-builder /app/dist ./dist
COPY backend/package.json ./

# Copy backend font assets
COPY backend/assets/fonts /app/assets/fonts

# Copy frontend build to nginx html directory
COPY --from=frontend-builder /app/dist /usr/share/nginx/html

# Copy frontend font files
COPY frontend/public/fonts /usr/share/nginx/html/fonts

# Copy nginx config
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default

# Copy s6-overlay service definitions
COPY docker/cont-init.d/ /etc/cont-init.d/
COPY docker/services.d/ /etc/services.d/
RUN chmod +x /etc/cont-init.d/* && \
    chmod +x /etc/services.d/*/run

# Create required directories
RUN mkdir -p /app/uploads/screens /app/uploads/firmware /app/uploads/widgets \
    /app/uploads/captures /app/uploads/drawings /app/logs \
    /data

# Create non-root user for backend process
RUN useradd --system --no-create-home --shell /usr/sbin/nologin inker && \
    chown -R inker:inker /app

EXPOSE 80

# Health check via nginx
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD bun -e "const r=await fetch('http://127.0.0.1/health');process.exit(r.ok?0:1)" || exit 1

# s6-overlay entrypoint
ENTRYPOINT ["/init"]
