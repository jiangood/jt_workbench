# 生产零运行时依赖：只装 esbuild 产物（决策 #15）
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist/agent.mjs ./agent.mjs
CMD ["node", "agent.mjs"]
