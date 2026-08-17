# Docker Deployment Guide

[中文](docker-deployment.md)

The official Scriverse image is published on Docker Hub as `musnows/scriverse`. Release images support both `linux/amd64` and `linux/arm64`.

## Prerequisites

- Docker Engine 24+ with the Docker Compose plugin.
- A dedicated persistent volume for Scriverse data.
- An HTTPS-capable reverse proxy such as Nginx, Caddy, or Traefik for public deployments.

The container listens on `0.0.0.0:13210` and stores data in `/app/.data`. This directory contains the SQLite database, WAL/SHM files, and the `master.key` used to encrypt AI-provider credentials. Persist, back up, and restore it as one unit.

## Deploy with Docker Compose

Create a dedicated directory with this `compose.yaml`:

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
      SCRIVERSE_AI_RETRY_COUNT: "${SCRIVERSE_AI_RETRY_COUNT:-3}"
      SCRIVERSE_AI_BACKOFF_RETRY_COUNT: "${SCRIVERSE_AI_BACKOFF_RETRY_COUNT:-10}"
      SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS: "${SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS:-30}"
      SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION: "${SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION:-5}"
      SCRIVERSE_STARTUP_RETRY_LIMIT: "${SCRIVERSE_STARTUP_RETRY_LIMIT:-2}"
    volumes:
      - scriverse-data:/app/.data

volumes:
  scriverse-data:
    name: scriverse-data
```

Create a `.env` file that is not committed to version control:

```dotenv
SCRIVERSE_TAG=latest
APP_ALLOW_REGISTRATION=true
APP_SETUP_TOKEN=replace-with-at-least-32-random-characters
APP_TRUST_PROXY=false
SCRIVERSE_AI_RETRY_COUNT=3
SCRIVERSE_AI_BACKOFF_RETRY_COUNT=10
SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS=30
SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION=5
SCRIVERSE_STARTUP_RETRY_LIMIT=2
```

Start the service:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Open [http://127.0.0.1:13210](http://127.0.0.1:13210), enter the setup token, and create the first administrator account.

After the administrator exists, change `.env` to:

```dotenv
APP_ALLOW_REGISTRATION=false
APP_SETUP_TOKEN=
```

Recreate the container so the setting takes effect:

```bash
docker compose up -d --force-recreate
```

Registration is enabled only when `APP_ALLOW_REGISTRATION` is `true` or `1`; `false` or `0` disables it, and `APP_SETUP_TOKEN` must contain at least 32 characters. Unset and all other values disable both the UI and backend registration endpoint, including first-administrator setup on an empty database. The setup token is checked only when creating the first administrator.

`SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION` controls how many complete pre-migration database backups are retained. It defaults to 5 and is clamped to a minimum of 2. On each startup, the oldest excess complete backups are removed before a new migration backup is created, preventing a failed-migration restart loop from filling the disk.

`SCRIVERSE_STARTUP_RETRY_LIMIT` controls consecutive failed startup attempts and defaults to 2. Once the limit is reached, the service stops repeating initialization and migration, preserving `<DATA_DIR>/.startup-retry.json` for diagnosis. Fix the root cause, remove that file, and restart the service.

`SCRIVERSE_AI_RETRY_COUNT` controls retries for AI upstream HTTP errors other than `403`, `429`, and `502`, defaulting to 3. `SCRIVERSE_AI_BACKOFF_RETRY_COUNT` controls exponential-backoff retries for `429` and `502`, defaulting to 10. Valid integers for both are clamped to 1–20 and invalid values fall back to their defaults; `403` is never retried. Backoff starts at 500 milliseconds and is capped at 5 seconds, including numeric `Retry-After` values. Recreate the container after changing either setting.

`SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS` controls how long an interactive AI stream waits for its first or next valid event. It defaults to 30 seconds; valid integers are clamped to 10–120 seconds and invalid values fall back to 30. Each valid event restarts the timer, so this is not a total-duration limit and does not change timeout behavior for analysis tasks or other AI requests. Recreate the container after changing it.

## Container runtime hardening

The official image runs as the non-root UID/GID `1000:1000`, and its runtime layer contains neither a shell nor a package manager. The Compose example above also makes the root filesystem read-only, drops every Linux capability, prevents privilege escalation, limits process creation, and exposes only a `noexec`, `nosuid`, `nodev` in-memory `/tmp`; the `/app/.data` volume remains writable.

Do not run Scriverse as `privileged` or with `network_mode: host`, and never mount the Docker socket, the host root, devices, or unrelated host paths into the container. Keep the host kernel and Docker Engine security updates current, and prefer rootless Docker where practical. These controls reduce lateral movement and container-escape impact after a vulnerability; they do not replace HTTPS, strong credentials, a least-privilege reverse proxy, or regular backups.

## Pin a release

`latest` is convenient for evaluation. Production deployments should pin a tag listed in [GitHub Releases](https://github.com/musnows/Scriverse/releases), for example:

```dotenv
SCRIVERSE_TAG=v0.3.3
```

Pinning prevents an unreviewed update from being pulled when the container is recreated.

## Logs and health checks

Follow structured runtime logs:

```bash
docker compose logs --follow --tail=200 scriverse
```

Successful startup emits `server.listening` with the running `version`. Passwords, session tokens, API keys, and provider credentials are redacted from logs.

The image includes a health check. Inspect it and call the endpoint directly:

```bash
docker compose ps
docker inspect --format '{{json .State.Health}}' scriverse
curl --fail http://127.0.0.1:13210/api/health
```

A healthy response contains `status: "ok"` and the running version.

## Back up data

Stop application writes before a backup:

```bash
docker compose stop scriverse
```

Back up the complete `scriverse-data` volume instead of copying only `novel.db`. Missing the database, WAL/SHM files, or `master.key` can result in incomplete data or provider credentials that can no longer be decrypted.

Start the service after the backup finishes:

```bash
docker compose start scriverse
```

For a bind mount, ensure the directory is writable by the non-root `node` user inside the container. Do not use `chmod 777` on the data directory.

## Upgrade

1. Back up the complete data volume.
2. Change `SCRIVERSE_TAG` in `.env` to the target release.
3. Pull and recreate the container.
4. Verify health, startup version logs, and critical data.

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 scriverse
```

Never delete the data volume to work around an upgrade problem. Scriverse applies forward-compatible database migrations during startup.

## HTTPS reverse proxy

The Compose example binds only to the host loopback interface, which is suitable for a reverse proxy on the same machine. Public access must use HTTPS. Example Nginx location:

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

For a single trusted proxy hop on the same host, set:

```dotenv
APP_TRUST_PROXY=1
```

Use the actual trusted hop count for other topologies instead of setting `true` blindly. Optional `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD` values add an HTTP Basic Auth deployment gateway. The password must contain at least 12 characters and be transported only over HTTPS.

## Build locally

To test unpublished code, build from the repository root:

```bash
docker build --tag scriverse:local .
```

Temporarily change the Compose `image` to `scriverse:local`. Production deployments should use the official multi-architecture release image produced by the publishing workflow.

## Troubleshooting

### The page says registration is disabled

Set `APP_ALLOW_REGISTRATION=true` and an `APP_SETUP_TOKEN` of at least 32 characters for first-time setup, then recreate the container. Disable registration and clear the token immediately after creating the administrator.

### The container keeps restarting

Run `docker compose logs --tail=200 scriverse`. Check that the data volume is writable, environment values are valid, and the port is available.

### Provider credentials fail after migration

Confirm that the complete `/app/.data` directory was migrated, especially the original `master.key`. Copying only the database cannot decrypt credentials stored by the previous environment.
