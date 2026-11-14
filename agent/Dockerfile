# Agent 主程序保持单文件 bundle；远程脚本需要从 /app/node_modules 解析预装依赖。
FROM node:22-bookworm-slim AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS build
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 版本号由 release.yml 的 build-arg 传入（发布 tag 去掉前缀 v）；本地构建回退 dev
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=$AGENT_VERSION
RUN npm run build

FROM node:22-bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/piper/voices \
 && case "$TARGETARCH" in \
      amd64) PARCH=x86_64 ;; \
      arm64) PARCH=aarch64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_${PARCH}.tar.gz" | tar -xz -C /opt \
 && curl -fsSL -o /opt/piper/voices/zh_CN-huayan-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx" \
 && curl -fsSL -o /opt/piper/voices/zh_CN-huayan-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json"
WORKDIR /app
COPY --from=build /app/dist/agent.mjs ./agent.mjs
COPY --from=build /app/dist/remote-libs ./dist/remote-libs
COPY --from=runtime-deps /app/node_modules ./node_modules
ENV PIPER_BIN=/opt/piper/piper
ENV PIPER_VOICE_DIR=/opt/piper/voices
ENV LD_LIBRARY_PATH=/opt/piper
CMD ["node", "agent.mjs"]
