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
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 256
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m
    ports:
      - "127.0.0.1:13210:13210"
    environment:
      APP_ALLOW_REGISTRATION: "${APP_ALLOW_REGISTRATION:-false}"
      APP_SETUP_TOKEN: "${APP_SETUP_TOKEN:-}"
      APP_TRUST_PROXY: "${APP_TRUST_PROXY:-false}"
      SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION: "${SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION:-5}"
      SCRIVERSE_STARTUP_RETRY_LIMIT: "${SCRIVERSE_STARTUP_RETRY_LIMIT:-2}"
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
APP_SETUP_TOKEN=请替换为至少32个字符的随机初始化令牌
APP_TRUST_PROXY=false
SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION=5
SCRIVERSE_STARTUP_RETRY_LIMIT=2
```

启动服务：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

访问 [http://127.0.0.1:13210](http://127.0.0.1:13210)，输入初始化令牌并创建首个管理员账户。

首个管理员创建完成后，将 `.env` 中的注册开关改为：

```dotenv
APP_ALLOW_REGISTRATION=false
APP_SETUP_TOKEN=
```

重新创建容器，让配置立即生效：

```bash
docker compose up -d --force-recreate
```

`APP_ALLOW_REGISTRATION` 只有明确设置为 `true` 或 `1` 时才开放注册；`false` 或 `0` 表示关闭，同时必须配置至少 32 个字符的 `APP_SETUP_TOKEN`。未设置或其他值都会同时关闭前端注册入口和后端注册接口，包括空数据库的首位管理员注册。初始化令牌只在创建首位管理员时校验。

`SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION` 控制启动迁移前的完整数据库备份保留数量，默认保留 5 个版本，最少保留 2 个版本。每次启动时会清理超出数量的最旧完整备份，再为本次迁移保留一个备份位置，避免迁移失败后的重启循环持续占满磁盘。

`SCRIVERSE_STARTUP_RETRY_LIMIT` 控制连续启动失败的次数，默认允许 2 次。达到上限后服务会停止重复执行初始化和迁移流程，并保留 `<DATA_DIR>/.startup-retry.json` 供排查；修复根因后删除该文件再启动服务。

## 容器运行时加固

官方镜像使用 UID/GID `1000:1000` 的非 root 进程，运行层不包含 shell 或包管理器。上面的 Compose 配置进一步启用只读根文件系统、移除全部 Linux capabilities、禁止提权、限制进程数量，并只为 `/tmp` 提供带 `noexec`、`nosuid`、`nodev` 的临时内存文件系统；持久卷 `/app/.data` 仍保持可写。

不要为 Scriverse 容器开启 `privileged`、`network_mode: host`，不要映射 Docker socket、宿主机根目录、设备或其他无关的宿主机路径。及时安装宿主机内核与 Docker 安全更新；条件允许时优先使用 Docker rootless 模式。这些边界与应用鉴权共同降低漏洞后的横向移动和容器逃逸风险，不能替代 HTTPS、强口令、最小权限反向代理和定期备份。

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

### S3 备份加密与手动恢复

系统管理员可以在“设置 → S3 备份”中开启全局备份加密。首次开启分为准备和确认两步：Scriverse 先生成一把 256 位 KEK（Key Encryption Key）并只在当前弹窗展示，此时加密仍保持关闭，备份不会使用这把待确认密钥。必须立即复制或下载密钥文件，将其保存到 Scriverse 设备和 S3 桶之外的安全位置，再确认“我已保存”；服务端收到一次性确认令牌后才会保存 KEK 并启用加密。若在确认前刷新或中断，下次开启会放弃旧的待确认密钥并重新生成，因此不会出现已启用但密钥无法取回的状态。密钥丢失后，即使数据库和 S3 对象仍然完好，加密备份也无法恢复。

开启后，每个数据库快照、`master.key` 和新上传图片都会使用独立随机 DEK（Data Encryption Key）执行 AES-256-GCM 加密；DEK 再由 KEK 通过 AES-256-GCM 包装。对象键不变，密文以 ASCII 魔数 `SCRIVERSE-ENC1` 开头。关闭加密只影响后续上传，不会删除 KEK，历史密文仍可用原密钥解密。已存在的明文图片对象不会自动重写；无论是否开启加密，仍建议使用私有桶，未开启时必须确保桶不允许公开读取。

版本 1 信封使用以下大端二进制布局：

```text
SCRIVERSE-ENC1 | version:u8 | algorithm:u8 |
wrap_iv_len:u8 | wrap_tag_len:u8 | payload_iv_len:u8 | payload_tag_len:u8 |
wrapped_dek_len:u16 | ciphertext_len:u64 |
wrap_iv | wrap_tag | payload_iv | payload_tag | wrapped_dek | ciphertext
```

`version` 和 `algorithm` 当前均为 `1`，IV 为 12 字节，GCM tag 为 16 字节，DEK 为 32 字节；从魔数到 `ciphertext_len` 末尾的固定头同时作为包装 DEK 和数据负载的 GCM AAD。

当前版本不提供完整恢复 CLI。需要手动恢复时：

1. 从 S3 下载目标数据库快照和同一备份根路径下的 `master.key`；需要恢复图片时一并下载对应对象。
2. 检查对象是否以 `SCRIVERSE-ENC1` 开头。没有魔数的旧对象是明文，不应套用解密流程。
3. 将用户留存的 base64url KEK 解码为 32 字节，按信封长度字段切分各部分。
4. 以固定头作为 AAD，使用 KEK、`wrap_iv` 和 `wrap_tag` 解密 `wrapped_dek`，得到 32 字节 DEK。
5. 继续以固定头作为 AAD，使用 DEK、`payload_iv` 和 `payload_tag` 解密 `ciphertext`。数据库对象应得到原始 SQLite 文件，`master.key` 对象应得到原始 CredentialVault 主密钥。
6. 停止 Scriverse 写入后，将恢复出的数据库与 `master.key` 按完整数据卷恢复规范放回；启动前先在副本上执行 SQLite 完整性和外键检查。

任何魔数、版本、长度、GCM tag 或密钥校验失败都应视为对象损坏或密钥不匹配，不得继续用不完整结果启动服务。

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

首次初始化时必须设置 `APP_ALLOW_REGISTRATION=true` 和至少 32 个字符的 `APP_SETUP_TOKEN`，然后重新创建容器。创建管理员后应立即关闭注册并清空初始化令牌。

### 容器不断重启

运行 `docker compose logs --tail=200 scriverse` 检查结构化错误日志。重点确认数据卷可写、环境变量格式正确、端口未被占用。

### AI 供应商密钥迁移后无法使用

确认迁移的是完整 `/app/.data`，尤其是原有的 `master.key`。仅复制数据库文件无法解密原环境保存的密钥。
