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

Create a `.env` file that is not committed to version control:

```dotenv
SCRIVERSE_TAG=latest
APP_ALLOW_REGISTRATION=true
APP_TRUST_PROXY=false
```

Start the service:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Open [http://127.0.0.1:13210](http://127.0.0.1:13210) and create the first administrator account.

After the administrator exists, change `.env` to:

```dotenv
APP_ALLOW_REGISTRATION=false
```

Recreate the container so the setting takes effect:

```bash
docker compose up -d --force-recreate
```

Registration is enabled only when `APP_ALLOW_REGISTRATION` is exactly `true`. Unset, `false`, and all other values disable both the UI and backend registration endpoint, including first-administrator setup on an empty database.

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

Set `APP_ALLOW_REGISTRATION=true` for first-time setup and recreate the container. Disable it immediately after creating the administrator.

### The container keeps restarting

Run `docker compose logs --tail=200 scriverse`. Check that the data volume is writable, environment values are valid, and the port is available.

### Provider credentials fail after migration

Confirm that the complete `/app/.data` directory was migrated, especially the original `master.key`. Copying only the database cannot decrypt credentials stored by the previous environment.
