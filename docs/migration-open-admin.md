# jt_workbench 迁移：open-admin 全量改造（已收口）

> 目标：将 Node 单体（Hono + SQLite + R2 + 零构建 SPA）全量迁移为 [open-admin](https://github.com/jiangood/open-admin) 业务项目（Spring Boot + React/antd + H2），替换现有 SPA。
> 迁移主跟踪关联 issue #46（去 CF 单体化）；本迁移为其后续阶段，仓库旧 Node/Hono 单体与零构建 SPA 实现已移除，当前以 open-admin 新栈为准。
> 框架版本：`@jiangood/open-admin` 3.3.2（后端 `io.github.jiangood:open-admin`）；文档见 `docs/open-admin/`。

## 现状 → 目标映射

| 层 | 原实现（已退役） | 目标/现状（open-admin） |
|---|---|---|
| 运行时 | Node 22 + Hono（旧 Node 单体服务） | Spring Boot 4.1 + Java 21（repo 根 `pom.xml`） |
| 数据库 | SQLite（D1 兼容适配，旧 migrations 0001-0056） | H2 文件模式（MySQL 兼容模式），JPA 自动建表；可选 MySQL |
| 对象存储 | R2 S3 兼容（旧 `core/files.ts`） | 框架 `FileOperator(S3)`（AWS SDK v2，兼容 R2）；存量对象 key 保持不变 |
| 认证 | 单用户 JWT Cookie | 框架用户/角色/权限/会话体系（admin/Open@1234 初始化，首登改密） |
| 调度 | 进程内 croner（旧 Node 调度与脚本） | Quartz `BaseJob`（框架定时任务页管理，进度上报/执行日志） |
| 前端 | 零构建 SPA（hash 路由） | Vite + React 19 + antd 6（`web/src/pages/`，vite-plugin 扫描路由） |
| 部署 | Node/Docker 基座 | 根目录 `Dockerfile`（Spring Boot 镜像 8080）+ `deploy/docker-compose.yml`（仅 app 服务，内置 H2 零依赖；可选 MySQL 自行部署） |

## 业务模块

依赖与权限：各模块 API 权限码定义在 `src/main/resources/menu-jt.yml`。
规范：Controller `admin/` 前缀、`AjaxResult`、`@HasPermission`；Entity 继承 `BaseEntity`（**epoch 毫秒时间字段需自定义列，不使用 BaseEntity 的 createTime 语义**）；Service 继承 `BaseService`。

| # | 模块 | 后端 | 前端 | 备注 |
|---|---|---|---|---|
| 1 | news 资讯 | news_source / news_item / news_block_word + 游标分页、已读/收藏 | `web/src/pages/news/`（DOMPurify 客户端消毒） | RSS 抓取 Quartz 作业 |
| 2 | stock 股票 | stock_watch / stock_daily + 行情搜索/实时/日K 代理（东财/新浪/腾讯） | `web/src/pages/stock/` | 外部行情接口 Referer/UA 限制 |
| 3 | note 笔记 | note_folder / note + 检索 + 附件 | `web/src/pages/note/` | FTS5 → H2 全文检索/LIKE 方案 |
| 4 | music 音乐 | music + 上传/元数据/Range 播放 | `web/src/pages/music/`（music-metadata 浏览器解析） | 大文件分片 → 框架 SysFile 分片上传 |
| 5 | book 书架 | book + 豆瓣搜索/建档/封面代理 + EPUB 上传/进度/阅读 | `web/src/pages/book/`（epub.js） | 豆瓣反爬（Referer 代理） |
| 6 | reminder 提醒 | reminder + 递推计算（公历/农历）+ 发送 | `web/src/pages/reminder/` | 农历库（lunar-java）；邮件复用框架 MailService |
| 7 | zsxq 星球 | zsxq_group/column/topic/comment/file/sync_state + 检索 + 代理 | `web/src/pages/zsxq/` | 星球同步单一 Quartz 作业（每 3 小时，执行前校验 token；话题/专栏/图片回填）＋风控冷却，详见 [`zsxq-sync.md`](zsxq-sync.md)；token 存框架系统参数 |
| 8 | admin/jobs | dashboard 汇总、磁盘分析、参数密钥、任务记录 | dashboard/admin 页面 | 部分能力由框架内置页提供（系统参数/操作日志/定时任务页） |

## 阶段记录

- **阶段 1（已完成）**：骨架——repo 根 Spring Boot 工程 + `web/` 前端工程，可编译、可启动、可登录；菜单挂业务页。
- **阶段 2（已完成）**：模块移植——Entity/Repo/Service/Controller + 页面 + Quartz 作业落码并接入。
- **阶段 3（已完成）**：数据迁移——存量 SQLite 数据已导入 H2（保持 epoch 毫秒/布尔 0/1/JSON TEXT 语义；R2 key 不变）；一次性导入脚本与后台导入页已移除。
- **阶段 4（已完成）**：部署切换与收口——根目录 Dockerfile（Spring Boot 镜像）、compose 更新（仅 app 服务，可选 MySQL）；CI/Release 切换为 Java/Web 新栈；旧 Node/Hono 单体与零构建 SPA 已移除，旧备份分支链路不再依赖。

## 本地启动

```bash
# 后端（首次自动建表 + 种子数据；默认管理员 admin / Open@1234）
mvn spring-boot:run -Dspring-boot.run.jvmArguments="-Ddb_path=./data/db/jt-workbench"

# 前端
cd web && npm install && npm run dev   # → http://localhost:7778
```
