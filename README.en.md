# Scriverse

[Chinese](README.md) | [English](README.en.md)

Scriverse is a local AI-assisted writing workspace for long-form fiction. It keeps manuscript text, volumes, characters, organizations, worldbuilding, timelines, relationship graphs, outlines, foreshadowing, and AI assistance in one project. It is designed for large, continuity-heavy novel projects.

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
| `DATA_DIR` | `<project>/.data` | Default data directory |
| `DATABASE_PATH` | `<DATA_DIR>/novel.db` | SQLite database path |
| `AI_NOVEL_MASTER_KEY` | Generated and stored at `<DATA_DIR>/master.key` | Master key used to encrypt AI provider credentials |

Custom configuration example:

```bash
PORT=13211 DATA_DIR=/path/to/scriverse-data npm run dev
```

## AI Provider Setup

1. Start Scriverse and open a work.
2. Open "AI Management" from the left navigation.
3. Add an OpenAI Chat Completions-compatible provider with its base URL and API key.
4. Add models and select a default model for each AI task.

New providers default to `10` concurrent requests, `10` RPM, and `32000` maximum output tokens. These limits are configurable per provider in the UI.

## Data and Security

- Application data is stored in `.data/novel.db` by default.
- AI provider credentials are encrypted. The default master key is `.data/master.key`.
- Back up both the database and the master key. Existing provider credentials cannot be decrypted if the master key is lost.
- Scriverse is currently designed as a local workspace and does not include user authentication. Do not expose it directly to the public internet without authentication at the reverse proxy and appropriate network access controls.

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
