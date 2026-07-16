<p align="center">
  <a href="https://scriverse.top/">
    <img src="./showcase/public/favicon.svg" alt="Scriverse" width="96">
  </a>
</p>

<h1 align="center">Scriverse</h1>

<p align="center">
  A local AI-assisted writing workspace for long-form fiction
</p>

<p align="center">
  <a href="README.md">中文</a> | <a href="README.en.md">English</a>
</p>

<p align="center">
  Scriverse is a local AI-assisted writing workspace for long-form fiction. It keeps manuscript text, volumes, characters, organizations, worldbuilding, timelines, relationship graphs, outlines, foreshadowing, and AI assistance in one project. It is designed for large, continuity-heavy novel projects.
</p>

<p align="center">
  Live demo: <a href="https://scriverse.top/">https://scriverse.top/</a>
</p>

## Features

- Work shelf for multiple novels, covers, authors, and descriptions.
- Manuscript editor with a volume/chapter tree, autosave, version history, line citations, blank-line normalization, and full-text search.
- Four chapter types: manuscript, setting, author's note, and other.
- TXT and DOCX import with volume, chapter, and postscript recognition.
- Setting library with character aliases, attributes, and locked fields.
- Organizations with descriptions, setting lists, and multi-organization character membership.
- Kanban-style timelines with multiple event tracks, split, merge, and ordering operations.
- Character relationships with categories, keyword lists, evidence, confidence, a standard graph, and an interactive 3D galaxy view.
- Chapter outlines and foreshadowing setup, reminder, and payoff tracking.
- Streaming AI chat with Markdown rendering, chapter line citations, and optional character or setting context.
- AI tasks for structure, chapters, character extraction, timelines, relationships, and consistency checks.
- OpenAI Chat Completions-compatible providers with configurable models, maximum output tokens, concurrency, and RPM.
- JSON, TXT, and Markdown export without AI credentials.

## Technology

- Node.js 22.5+
- TypeScript
- Express 5
- Node.js SQLite
- Vanilla HTML, CSS, and JavaScript
- Vitest and Supertest

## Quick Start

### Requirements

- Node.js `>= 22.5.0`
- npm

### Install and run for development

```bash
git clone git@github.com:musnows/Scriverse.git
cd Scriverse
npm ci
npm run dev
```

Open [http://localhost:13210](http://localhost:13210).

### Production build

```bash
npm run build
npm start
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `13210` | HTTP server port |
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` for a server deployment |
| `DATA_DIR` | `<project>/.data` | Default data directory |
| `DATABASE_PATH` | `<DATA_DIR>/novel.db` | SQLite database path |
| `AI_NOVEL_MASTER_KEY` | Generated and stored at `<DATA_DIR>/master.key` | Master key used to encrypt AI provider credentials |
| `APP_AUTH_USERNAME` | Empty | Optional deployment gateway username; the in-app user system is always enabled |
| `APP_AUTH_PASSWORD` | Empty | Optional deployment gateway password, at least 12 characters; must be transported over HTTPS |
| `APP_TRUST_PROXY` | `false` | Set to the trusted proxy hop count (usually `1`) or `true` behind a trusted reverse proxy |
| `APP_ALLOW_PRIVATE_AI_ENDPOINTS` | `true` in development, `false` in production | Allow AI providers on loopback/private networks; link-local and cloud metadata addresses are always blocked |
| `APP_ALLOW_REGISTRATION` | `true` | Set to `false` to disable open registration (first-admin setup remains allowed); recommended behind a public nginx reverse proxy |

Custom configuration example:

```bash
PORT=13211 DATA_DIR=/path/to/scriverse-data npm run dev
```

Server deployment example:

```bash
NODE_ENV=production \
HOST=0.0.0.0 \
APP_AUTH_USERNAME=admin \
APP_AUTH_PASSWORD='replace-with-a-long-random-password' \
npm start
```

Production deployments must use HTTPS at a trusted reverse proxy. On first launch, the first registered user becomes the system administrator; later registrations are normal users. Optional HTTP Basic Auth is only an additional deployment gateway, and its credentials are merely Base64 encoded. `/api/health` remains public for health checks, while business APIs require an in-app login.

## AI Provider Setup

1. Start Scriverse and open the top-level **AI Management** page.
2. Add an OpenAI Chat Completions-compatible provider with its base URL, API key, concurrency, RPM, and maximum output tokens.
3. Add models with their supported context-window size in tokens.
4. Set a platform-wide system prompt; it is appended after Scriverse's built-in prompt.
5. In a work, open **More → AI Settings** to set the work-specific appended system prompt and default models. The work prompt is appended after the platform prompt.

New providers default to `10` concurrent requests, `10` RPM, and `32000` maximum output tokens. New models default to a `128000`-token context window. The chat sidebar displays a context-usage ring for the selected model.

## Data and Security

- Application data is stored in `.data/novel.db` by default.
- AI provider credentials are encrypted. The default master key is `.data/master.key`.
- Back up both the database and the master key. Existing provider credentials cannot be decrypted if the master key is lost.
- Scriverse does not include a user system. Server deployments use single-instance HTTP Basic Auth configured through environment variables, and production startup fails when credentials are missing.
- The server listens on `127.0.0.1` by default. Non-loopback listening also requires authentication. Public entry points must use HTTPS, a trusted reverse proxy, and firewall access controls.
- CSP, clickjacking protection, MIME sniffing protection, same-origin write validation, authentication and API rate limits, body/upload limits, and AI-provider SSRF protection are enabled by default.
- SQLite values are bound through prepared statements. Dynamic SQL fragments are limited to server-controlled branches and never contain request input.

## Testing

```bash
# Type checking
npm run typecheck

# All Vitest tests
npm test

# Unit, integration, and system suites
npm run test:unit
npm run test:integration
npm run test:system

# Real end-to-end tests against a running server
npm run test:e2e:real

# Type checking, all tests, and a production build
npm run check
```

`test:e2e:real` uses `http://127.0.0.1:13210/api` by default. Set `E2E_BASE_URL` when the server runs elsewhere:

```bash
E2E_BASE_URL=http://127.0.0.1:13211/api npm run test:e2e:real
```

## Project Structure

```text
src/
  ai.ts                  AI calls, context building, and task orchestration
  app.ts                 Express API and static UI entry point
  database.ts            SQLite schema and migrations
  parser.ts              TXT/DOCX novel structure parser
  server.ts              Server startup and shutdown
  store.ts               Application data access
  public/                Browser UI and visualizations
tests/
  unit/                  Unit tests
  integration/           API and data integration tests
  system/                Complete author workflow tests
  e2e/                   End-to-end tests against a running server
```

## Health Check

```bash
curl http://127.0.0.1:13210/api/health
```

Expected response:

```json
{
  "data": {
    "status": "ok",
    "version": "0.1.0",
    "protocol": "openai-chat-completions"
  }
}
```

## Project Status

Scriverse is currently an MVP. APIs and data structures may still change. Back up the `.data` directory before upgrading.
