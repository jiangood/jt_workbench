# 部署

## Spring Boot（open-admin，Docker Compose）

`ci.yml` 在 push `v*` tag（或手动触发）时构建并推送 `:latest`/`:sha-<commit>` 镜像至 GitHub Container Registry（GHCR）；`release.yml` 在 push `vX.Y.Z` tag（或手动指定 tag）时构建并推送版本镜像并创建 GitHub Release。镜像地址为 `ghcr.io/jiangood/jt_workbench`（仅 amd64），**本地不 docker build**；部署 compose 使用 GHCR 地址拉取：

```bash
# 包为私有（默认）时先登录：docker login ghcr.io -u <GitHub 用户名> -p <带 read:packages 的 PAT>
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

## 回滚

- 镜像回退到上一 tag：调整 compose 镜像版本后 `docker compose pull && docker compose up -d`
- 数据恢复按实际环境执行（如 H2 数据卷 `deploy/app-data/` 或 MySQL 备份）；建议在升级前自行备份数据目录/数据库。
