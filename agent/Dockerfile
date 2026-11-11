# 生产零运行时依赖：只装 esbuild 产物（决策 #15）
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 版本号由 release.yml 的 build-arg 传入（发布 tag 去掉前缀 v）；本地构建回退 dev
ARG AGENT_VERSION=dev
ENV AGENT_VERSION=$AGENT_VERSION
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist/agent.mjs ./agent.mjs
CMD ["node", "agent.mjs"]
