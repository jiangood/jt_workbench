# 部署

## Spring Boot（open-admin，Docker Compose）

`release.yml` 在 push `vX.Y.Z` tag（或手动指定 tag）时执行 Docker 多阶段构建（含后端 `mvn verify` 与前端构建），仅推送 `:latest` 镜像至 GitHub Container Registry（GHCR），并创建 GitHub Release。镜像地址为 `ghcr.io/jiangood/jt_workbench`（仅 amd64），**本地不 docker build**。

## 线上自动更新（Watchtower）

线上目标机运行 Watchtower，监控 `ghcr.io/jiangood/jt_workbench:latest`：

- 约每 5 分钟检查一次新镜像。
- 发现新镜像后自动拉取，向旧应用容器发送 `SIGTERM`，等待最多 60 秒优雅停止，再启动新容器。
- 更新成功后删除旧镜像；因此 tag 发布成功即进入自动部署队列，通常无需手工执行 compose 更新。
- 发布后必须监控 Watchtower/应用日志，并验证公开接口直至返回 200；构建成功不代表容器一定启动成功。

只读排查命令（在线上 compose 项目目录执行）：

```bash
docker compose ps
docker compose logs --tail 100 watchtower
docker compose logs --tail 100 workbench
```

## 手动更新（备用）

无 Watchtower 的环境或应急恢复时，可手动拉取并重建；包为私有（默认）时目标机需先登录 GHCR：

```bash
docker login ghcr.io -u <GitHub 用户名> -p <带 read:packages 的 PAT>
# 也可以把包设为 public，之后无需登录
cd deploy
docker compose pull && docker compose up -d
```

- `app`：Spring Boot，端口 `8080`，compose 只管应用自己
- **内置 H2（默认，零依赖）**：应用回落到 H2 文件库（MySQL 兼容模式），首次启动自动建表并写入种子数据；数据落 `deploy/app-data/` → 容器内 `/data`
- **MySQL 可选（自行部署）**：在 compose 的 `environment` 加回数据库连接即可（应用侧无需改代码）：
  ```yaml
  environment:
    - SPRING_DATASOURCE_DRIVER_CLASS_NAME=com.mysql.cj.jdbc.Driver
    - SPRING_DATASOURCE_URL=jdbc:mysql://host.docker.internal:3306/jt_workbench?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true
    - SPRING_DATASOURCE_USERNAME=root
    - SPRING_DATASOURCE_PASSWORD=你的密码
    - SPRING_JPA_PROPERTIES_HIBERNATE_DIALECT=org.hibernate.dialect.MySQLDialect
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```
  `ddl-auto: update` 自动建表（需先自行建库 `jt_workbench`）
- **S3（对象存储）不在 compose 配置**：部署后在 Web 管理界面配置
- Dockerfile 位于仓库根目录（三阶段构建：Maven 后端 + Vite 前端 + JRE 运行）

## 验证

```bash
curl -s http://localhost:8080/admin/public/site-info
```

## 数据恢复

- 数据恢复按实际环境执行（如 H2 数据卷 `deploy/app-data/` 或 MySQL 备份）；建议在升级前自行备份数据目录/数据库。
