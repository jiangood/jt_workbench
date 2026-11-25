# ===================================================================
# jt_workbench 多阶段 Docker 构建（参考 open-admin 框架 Dockerfile）
# ===================================================================
# 后端（Spring Boot JAR）+ 前端（Vite/React dist）打进同一镜像：
#   docker build -t jt-workbench .
# 数据（上传文件/日志）持久化在容器内 /data/db/jt-workbench，请挂载数据卷。
# ===================================================================

# 后端构建阶段
FROM maven:3.9-eclipse-temurin-21 AS build-backend
WORKDIR /build

COPY pom.xml ./
RUN mvn -B -ntp -U dependency:go-offline -q

COPY src ./src
RUN mvn -B -ntp -U verify

# ===================================================================
# 前端构建阶段
# ===================================================================
FROM node:24 AS build-frontend
WORKDIR /build

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# ===================================================================
# 运行阶段
# ===================================================================
FROM eclipse-temurin:21-jre
WORKDIR /app

# 从后端构建阶段复制 JAR
COPY --from=build-backend /build/target/*.jar app.jar

# 从前端构建阶段复制静态文件到 static/ 目录（框架托管 file:./static/）
COPY --from=build-frontend /build/dist/ ./static/

# 数据目录（上传文件、日志），运行时挂载数据卷
RUN mkdir -p /data/db/jt-workbench
VOLUME ["/data"]

# 时区与默认运行 profile（profile 作为可覆盖的默认值，避免写死在命令行参数里）
ENV TZ=Asia/Shanghai \
    SPRING_PROFILES_ACTIVE=prod
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

EXPOSE 8080

ENTRYPOINT ["java","-Djava.security.egd=file:/dev/./urandom","-Duser.timezone=Asia/Shanghai","-jar","/app/app.jar"]
