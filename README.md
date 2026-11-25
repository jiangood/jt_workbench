# jt_workbench

个人工作台：基于 [open-admin](https://github.com/jiangood/open-admin) 的 Spring Boot 应用（后端 `src/` + 前端 `web/`，内置 H2 / 可选 MySQL，对象存储走 R2 S3 兼容接口）。

- 开发 / 约定：`AGENTS.md`
- open-admin 迁移记录：`docs/migration-open-admin.md`
- 旧系统参考（只读）：`D:\ws\workbench`

## 结构

| 目录 | 说明 |
|------|------|
| `src/` | Spring Boot 后端（业务模块、Quartz 作业等） |
| `web/` | 前端（Vite + React 19 + antd 6） |
| `deploy/` | 部署基座：`docker-compose.yml`（app 服务）与部署说明；Dockerfile 位于仓库根目录 |
| `.github/workflows/` | 发布工作流：`release.yml`（Docker 构建校验 + GHCR 镜像发布 + GitHub Release） |
| `docs/` | 项目与框架文档（含 `docs/open-admin/`、迁移记录） |

## 本地开发与验证

```bash
# 后端（首次自动建表 + 种子数据；默认管理员 admin / Open@1234）
mvn spring-boot:run -Dspring-boot.run.jvmArguments="-Ddb_path=./data/db/jt-workbench"

# 前端
cd web && npm install && npm run dev   # → http://localhost:7778

# 自检（与发布工作流对齐）
mvn -B -ntp verify
cd web && npm ci --registry=https://registry.npmmirror.com && npm run build
```

- 默认使用 H2 文件库（MySQL 兼容模式）；容器/生产环境可通过环境变量切换为 MySQL（见 `deploy/README.md`、`src/main/resources/application.yml`）。
- S3（对象存储）不在 compose/代码硬编码，部署后在 Web 管理界面配置；R2 bucket 为 `jt-workbench`（`zll-*` 属于另一个项目，勿混用）。

## 发布与运维

- **最新镜像**：`release.yml` 在 push `v*` tag 且校验通过后构建并仅推送 `:latest` 镜像至 GHCR（仅 amd64）。
- **版本发布与自动部署**：`release.yml` 在 push `vX.Y.Z` tag（或手动指定 tag）时创建 GitHub Release；线上目标机的 Watchtower 约每 5 分钟检查一次 `:latest`，发现新镜像后自动拉取并重建应用容器。手动 `docker compose pull && docker compose up -d` 仅用于无 Watchtower 环境或应急恢复（详见 `deploy/README.md`）。
- **禁止直操作生产**：本地不对线上资源做写操作；线上变更走既定发布流程।
