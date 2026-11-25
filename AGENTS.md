# 项目约定（jt_workbench）

个人工作台，基于 [open-admin](https://github.com/jiangood/open-admin) 的 Spring Boot 业务项目（后端 Java + 前端 React/antd）。

## 布局

- `src/`：后端（`com.jt.workbench`，业务模块 `modules/*`、Quartz 作业等）；配置 `src/main/resources/application.yml`、`menu-jt.yml`
- `web/`：前端（Vite + React 19 + antd 6，`@jiangood/open-admin`/vite-plugin；页面 `web/src/pages/`）
- `deploy/`：Docker Compose 基座（`docker-compose.yml`、`README.md`）；仓库根 `Dockerfile` 为多阶段构建（Maven + Vite + JRE）
- `docs/`：项目文档与框架文档（`docs/open-admin/`、`docs/migration-open-admin.md`）
- `.github/workflows/`：`release.yml`（Docker 多阶段构建，在镜像内执行后端 `mvn verify` 与前端构建；触发：push `v*` tag / `workflow_dispatch`，仅推送 `:latest` 至 GitHub Container Registry amd64，并创建 GitHub Release）
- R2 bucket 为 `jt-workbench`（`zll-*` 属于另一个项目，勿混用）
- 参考旧项目：`D:\ws\workbench`（只读）

## Git

- 功能性修改和文档修改直接提交并推送到 `main`；**禁止使用 Pull Request / 分支合并流程**（仓库协作以直推 `main` 为准）。
- 该约定也应在 GitHub 仓库设置中强制执行（具体菜单/控件名称以 GitHub 当前界面为准）：建议通过分支保护规则或仓库规则集限制 `main` 仅允许授权主体直推，并按团队策略关闭或限制 Pull Request 合并入口/权限。
- **提交前本地自检**：按改动范围运行对应检查/测试——后端变更跑 `mvn -B -ntp verify`，前端变更跑 `cd web && npm ci --registry=https://registry.npmmirror.com && npm run build`（与发布工作流对齐）。仓库提供 `.githooks/pre-commit` 提示，可执行 `git config core.hooksPath .githooks` 启用。
- 直推 `main` **不会触发构建或发布**（`release.yml` 仅 `v*` tag push / `workflow_dispatch` 触发）；提交前务必完成本地自检。若手动触发或 tag 触发了工作流，需主动监控直至完成。

## 开发约定

- 遵循 open-admin 业务项目规范：Controller `admin/` 前缀、`AjaxResult`、`@HasPermission`；Entity 继承 `BaseEntity`（注意：**epoch 毫秒时间字段需自定义列，不使用 BaseEntity 的 createTime 语义**）；Service 继承 `BaseService`；API 权限码定义在 `src/main/resources/menu-jt.yml`（详见 `docs/open-admin/` 与 `.opencode/skills/oa-*`）。
- 数据库：默认 H2 文件库（MySQL 兼容模式），可切换 MySQL；`ddl-auto: update`。时间统一 epoch 毫秒语义、布尔 `0/1`、JSON 以文本存储的既有约定按模块保持一致。
- 对象存储：通过框架 `FileOperator(S3)` 访问 R2（S3 兼容）；部署后在 Web 管理界面配置，存量对象 key 保持不变。
- 调度：Quartz `BaseJob`（框架定时任务页管理），作业实现位于 `src/main/java/com/jt/workbench/modules/job/`。
- 分工红线：**服务端只做简单计算与展示**；浏览器承担展示类计算（DOMPurify / music-metadata / JSZip / lunar 等）。
- **上传一律支持分片**：大文件走框架 SysFile 分片上传；新增上传入口保持一致。
- 前端与样式遵循现有页面/组件模式与框架约定；低频配置收进弹窗、删除类操作收进「更多」下拉，高频只读操作留页面。
- **编码红线**：改文件一律使用 UTF-8；避免使用会破坏编码的 PowerShell 重定向/读写方式，优先用编辑工具或 Node 脚本。

## 发布与运维

- **版本号同步**：每次发布新版本时，必须同步修改后端 `pom.xml` 的项目 `<version>` 和前端 `web/package.json` 的 `version`，确保前后端版本号一致，并将其作为发布前检查项。
- `latest` 镜像：当前 **push 到 `main` 不会自动构建/推送镜像**。`release.yml` 在 push `v*` tag（或手动 `workflow_dispatch`）时执行 Docker 构建（内含后端测试/校验与前端构建），仅推送 `:latest` 至 GitHub Container Registry（GHCR，仅 amd64，`provenance: false`）。
- 版本发布：`release.yml` 在 push `vX.Y.Z` tag（或手动指定 tag）时构建并创建 GitHub Release；不推送版本或 `sha-*` 镜像标签。
- 部署 compose 使用 GHCR 地址 `ghcr.io/jiangood/jt_workbench:latest`，`docker compose pull && docker compose up -d` 更新（包为私有时目标机需先 `docker login ghcr.io`；详见 `deploy/README.md`）。
- **禁止直操作生产**：本地不对线上资源做写操作；线上变更走既定发布流程。
