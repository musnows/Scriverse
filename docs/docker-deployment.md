# Docker 部署指南

[English](docker-deployment.en.md)

Scriverse 官方镜像发布在 Docker Hub：`musnows/scriverse`。正式版本同时提供 `linux/amd64` 和 `linux/arm64` 镜像。

## 部署前准备

- Docker Engine 24+，并安装 Docker Compose 插件。
- 一个仅供 Scriverse 使用的持久化数据卷。
- 公网部署时准备支持 HTTPS 的反向代理，例如 Nginx、Caddy 或 Traefik。

容器内服务默认监听 `0.0.0.0:13210`，数据目录为 `/app/.data`。该目录包含 SQLite 数据库、WAL/SHM 文件和用于加密 AI 供应商密钥的 `master.key`，必须作为一个整体持久化、备份和恢复。

## 使用 Docker Compose 部署

创建一个独立目录，并在其中保存以下 `compose.yaml`：

```yaml
services:
  scriverse:
    image: musnows/scriverse:${SCRIVERSE_TAG:-latest}
    container_name: scriverse
    restart: unless-stopped
    ports:
      - "127.0.0.1:13210:13210"
    environment:
      APP_ALLOW_REGISTRATION: "${APP_ALLOW_REGISTRATION:-false}"
      APP_TRUST_PROXY: "${APP_TRUST_PROXY:-false}"
    volumes:
      - scriverse-data:/app/.data

volumes:
  scriverse-data:
    name: scriverse-data
```

创建不提交到版本控制的 `.env`：

```dotenv
SCRIVERSE_TAG=latest
APP_ALLOW_REGISTRATION=true
APP_TRUST_PROXY=false
```

启动服务：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

访问 [http://127.0.0.1:13210](http://127.0.0.1:13210)，创建首个管理员账户。

首个管理员创建完成后，将 `.env` 中的注册开关改为：

```dotenv
APP_ALLOW_REGISTRATION=false
```

重新创建容器，让配置立即生效：

```bash
docker compose up -d --force-recreate
```

`APP_ALLOW_REGISTRATION` 只有明确设置为 `true` 时才开放注册。未设置、`false` 或其他值都会同时关闭前端注册入口和后端注册接口，包括空数据库的首位管理员注册。

## 固定正式版本

快速体验可以使用 `latest`。生产环境建议在 `.env` 中固定到 [GitHub Releases](https://github.com/musnows/Scriverse/releases) 列出的具体版本，例如：

```dotenv
SCRIVERSE_TAG=v0.3.3
```

这样可以避免重新创建容器时意外拉取尚未验证的新版本。

## 日志与健康检查

查看结构化运行日志：

```bash
docker compose logs --follow --tail=200 scriverse
```

启动成功后会出现 `server.listening` 日志，其中包含正在运行的 `version`。日志不会输出账户密码、会话令牌、API Key 或供应商密钥等敏感值。

镜像内置健康检查。查看容器状态并直接调用健康接口：

```bash
docker compose ps
docker inspect --format '{{json .State.Health}}' scriverse
curl --fail http://127.0.0.1:13210/api/health
```

健康接口正常时返回 `status: "ok"` 和当前版本号。

## 数据备份

升级或迁移前先停止应用写入：

```bash
docker compose stop scriverse
```

备份整个 `scriverse-data` 卷，而不是只复制 `novel.db`。数据库、WAL/SHM 文件和 `master.key` 缺少任意一项，都可能导致数据不完整或已保存的 AI 供应商密钥无法解密。

备份完成后重新启动：

```bash
docker compose start scriverse
```

如果改用主机目录挂载，确保该目录可由容器内的非 root `node` 用户写入。不要使用 `chmod 777` 放宽整个数据目录权限。

## 升级

1. 备份完整数据卷。
2. 将 `.env` 中的 `SCRIVERSE_TAG` 改为目标版本。
3. 拉取镜像并重新创建容器。
4. 检查健康状态、启动版本日志和关键数据。

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 scriverse
```

禁止通过删除数据卷来解决升级问题。Scriverse 会在启动时对现有数据库执行向前兼容迁移。

## HTTPS 反向代理

Compose 示例只将端口绑定到宿主机回环地址，适合由同一台机器上的反向代理访问。公网入口必须启用 HTTPS。以 Nginx 为例：

```nginx
location / {
    proxy_pass http://127.0.0.1:13210;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_buffering off;
}
```

反向代理位于同一台宿主机且只有一跳时，将 `.env` 设置为：

```dotenv
APP_TRUST_PROXY=1
```

如果代理链路不同，应按实际可信代理跳数设置，不能盲目使用 `true`。可选的 `APP_AUTH_USERNAME` 和 `APP_AUTH_PASSWORD` 可以增加一层 HTTP Basic Auth 部署网关；密码至少 12 个字符，并且只能通过 HTTPS 传输。

## 本地构建镜像

需要验证未发布代码时，可以从仓库根目录构建本地镜像：

```bash
docker build --tag scriverse:local .
```

将 Compose 中的 `image` 临时改为 `scriverse:local` 后启动。正式部署建议继续使用发布流水线生成并签名记录来源的官方多架构镜像。

## 常见问题

### 页面显示“注册已禁用”

首次初始化时必须设置 `APP_ALLOW_REGISTRATION=true`，然后重新创建容器。创建管理员后应立即关闭该开关。

### 容器不断重启

运行 `docker compose logs --tail=200 scriverse` 检查结构化错误日志。重点确认数据卷可写、环境变量格式正确、端口未被占用。

### AI 供应商密钥迁移后无法使用

确认迁移的是完整 `/app/.data`，尤其是原有的 `master.key`。仅复制数据库文件无法解密原环境保存的密钥。
