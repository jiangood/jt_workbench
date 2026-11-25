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
| `.github/workflows/` | CI 与发布工作流：`ci.yml`（校验 + tag 构建 `latest` 镜像至 GHCR）、`release.yml`（tag 版本发布） |
| `docs/` | 项目与框架文档（含 `docs/open-admin/`、迁移记录） |

## 本地开发与验证

```bash
# 后端（首次自动建表 + 种子数据；默认管理员 admin / Open@1234）
mvn spring-boot:run -Dspring-boot.run.jvmArguments="-Ddb_path=./data/db/jt-workbench"

# 前端
cd web && npm install && npm run dev   # → http://localhost:7778

# 自检（与 CI 对齐）
mvn -B -ntp verify
cd web && npm ci --registry=https://registry.npmmirror.com && npm run build
```

- 默认使用 H2 文件库（MySQL 兼容模式）；容器/生产环境可通过环境变量切换为 MySQL（见 `deploy/README.md`、`src/main/resources/application.yml`）。
- S3（对象存储）不在 compose/代码硬编码，部署后在 Web 管理界面配置；R2 bucket 为 `jt-workbench`（`zll-*` 属于另一个项目，勿混用）。

## 发布与运维

- **最新镜像**：`ci.yml` 在 push `v*` tag 且校验通过后构建并推送 `:latest` 镜像（GHCR，仅 amd64）。
- **版本发布**：`release.yml` 在 push `vX.Y.Z` tag（或手动指定 tag）时构建并推送版本镜像至 GHCR 并创建 GitHub Release；目标机 `docker compose pull && docker compose up -d` 手动部署（详见 `deploy/README.md`）。
- **回滚**：镜像回退到上一 tag（或指定 `sha-<commit>`），并按实际环境恢复应用数据（如 H2/MySQL 数据目录或数据库备份）。
- **禁止直操作生产**：本地不对线上资源做写操作；线上变更走既定发布流程।
