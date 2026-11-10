# syntax=docker/dockerfile:1
# 微信云托管 & Docker 通用生产镜像（支持 Node.js + FFmpeg + LibreOffice + Poppler + 中文字体）

FROM node:20-bookworm-slim AS builder

WORKDIR /workspace

RUN corepack enable && (corepack prepare pnpm@9.6.0 --activate || npm install -g pnpm@9.6.0 --registry=https://registry.npmmirror.com)

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/

RUN pnpm --filter @tool-universal/shared --filter @tool-universal/backend install --no-frozen-lockfile --ignore-scripts --registry=https://registry.npmmirror.com

COPY packages/shared ./packages/shared
COPY backend ./backend

RUN pnpm --filter @tool-universal/shared build && \
    pnpm --filter @tool-universal/backend build && \
    pnpm --filter @tool-universal/backend --prod deploy --ignore-scripts /app/deploy

# ================= 运行时精简镜像 =================
FROM node:20-bookworm-slim AS runner

# 国内构建加速源（如在海外构建可删除或注释）
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources; \
    fi

# 安装底层转换引擎 + 中文字体（防止 Word/Excel/PPT 转 PDF 出现中文方块乱码）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    poppler-utils \
    fonts-noto-cjk \
    fontconfig \
    ca-certificates \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
# 微信云托管默认探测 80 端口
ENV PORT=80
ENV HOST=0.0.0.0
ENV STORAGE_MODE=cloudbase
ENV MAX_CONCURRENCY=2

COPY --from=builder /app/deploy ./
COPY --from=builder /workspace/backend/dist ./dist

RUN mkdir -p /app/tmp_storage

EXPOSE 80

CMD ["node", "dist/main.js"]
