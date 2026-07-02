---
name: wiki-sync
description: >
  Sync content to a Wiki.js instance. Use when user wants to upload/sync assets
  (images, files), push markdown pages, or build a navigation tree on Wiki.js.
  Triggers: "sync to wiki", "upload to wiki", "push pages", "update wiki",
  "sync docs", "wiki sync", "sync assets", "sync nav", "upload files to wiki".
---

# Wiki.js Content Sync

## Overview

This plugin provides three JavaScript sync scripts for pushing content to a Wiki.js
instance. All scripts are run with `bun run` and require the following environment
variables in a `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `WIKIJS_URL` | Yes | Wiki.js base URL (e.g. `http://192.168.0.101:3000`) |
| `WIKIJS_USERNAME` | Yes | Wiki.js username |
| `WIKIJS_PASSWORD` | Yes | Wiki.js password |
| `WIKIJS_STRATEGY` | Yes | Authentication strategy UUID |
| `WIKIJS_LOCALE` | No | Content locale (default: `zh`) |

## Prerequisites

```bash
# Install bun (if not already installed)
# https://bun.sh/docs/installation

# Run from the project root that contains src/ and .env
bun run src/upload.js --help
bun run src/sync-pages.js --help
bun run src/sync-nav.js --help
```

## Script 1: upload.js — Upload Files to Wiki.js

Uploads all files from a local `assets/` directory to a Wiki.js asset folder.
Each filename is `<uuid>.<ext>` (e.g. `bd223c82-b1b7-407b-8eb9-0ac4fc330d8f.png`).

### Modes

| Mode | Command | Purpose |
|------|---------|---------|
| Full sync | `bun run src/upload.js --all` | Upload all files (dry-run, preview only) |
| Full sync (push) | `bun run src/upload.js --all --concurrency 100` | Actually upload with 100 concurrent workers |
| Single file | `bun run src/upload.js <file-path>` | Upload one file |
| Single file (rename) | `bun run src/upload.js <file-path> <remote-name>` | Upload with custom remote name |
| List remote | `bun run src/upload.js --list` | Show files on server |

### Options

- `--assets-dir PATH` — Local assets directory (default: `assets`)
- `--folder-id ID` — Wiki.js folder ID (default: `1`)
- `--concurrency N` — Number of parallel upload workers (default: `5`)
- `--dry-run` — Preview mode, no actual uploads

### Workflow

When a user asks to upload/sync assets:
1. Ask for `WIKIJS_URL`, `WIKIJS_USERNAME`, `WIKIJS_PASSWORD`, and `WIKIJS_STRATEGY` if not already configured
2. Check that the assets directory exists and contains files
3. Run `--all` (dry-run first) to see what will be uploaded
4. Confirm with user, then run with `--concurrency 100`

## Script 2: sync-pages.js — Push Markdown Pages

Syncs `.md` files from a local `pages/` directory to Wiki.js. Each file is
named `<uuid>.md` (32 hex chars, no dashes) and is pushed to path
`pages/<uuid>` (no `.md` extension).

### Modes

| Mode | Command | Purpose |
|------|---------|---------|
| Full sync | `bun run src/sync-pages.js --all` | Sync all .md files (dry-run) |
| Full sync (push) | `bun run src/sync-pages.js --all --concurrency 100` | Actually push |
| Single page | `bun run src/sync-pages.js --page <uuid>` | Sync one page (dry-run) |
| Single page (push) | `bun run src/sync-pages.js --page <uuid> --concurrency 100` | Actually push |
| List remote | `bun run src/sync-pages.js --list` | Show pages on server |

### Options

- `--pages-dir PATH` — Local pages directory (default: `pages`)
- `--concurrency N` — Number of parallel workers (default: `5`)
- `--dry-run` — Preview mode, no actual pushes

### Page Title

The page title is extracted from the first `# Heading` in the markdown content.
If no heading is found, the uuid is used as the title.

### Workflow

When a user asks to sync pages:
1. Ask for `WIKIJS_URL` and auth if not already configured
2. Scan the pages directory and report count
3. Run `--all` (dry-run first) to preview changes
4. Confirm with user, then run with `--concurrency 100`

## Script 3: sync-nav.js — Build Navigation Tree

Builds a navigation hierarchy from `README.md` files under a configurable
folder (default: `nav/`). Each `README.md` becomes a folder page on Wiki.js:

```
<nav-root>/README.md          → wiki path: <nav-root>
<nav-root>/foo/README.md      → wiki path: <nav-root>/foo
<nav-root>/foo/bar/README.md  → wiki path: <nav-root>/foo/bar
```

### Modes

| Mode | Command | Purpose |
|------|---------|---------|
| Full sync | `bun run src/sync-nav.js --all` | Sync all README.md files (dry-run) |
| Full sync (push) | `bun run src/sync-nav.js --all --concurrency 100` | Actually push |
| Single page | `bun run src/sync-nav.js --rel ""` | Sync root README |
| Single page | `bun run src/sync-nav.js --rel "path/to/folder"` | Sync specific folder |
| Single push | `bun run src/sync-nav.js --rel "" --concurrency 100` | Push specific page |
| List remote | `bun run src/sync-nav.js --list` | Show nav pages on server |

### Options

- `--nav-root PATH` — Local nav root folder (default: `nav`)
- `--wiki-prefix PREFIX` — Wiki.js path prefix (default: nav-root folder name)
- `--concurrency N` — Number of parallel workers (default: `5`)
- `--dry-run` — Preview mode, no actual pushes

### Important: Nav Folder is Configurable

The navigation root folder is NOT hardcoded. **Always ask the user which
folder contains their navigation README.md files.** Then set it with
`--nav-root <folder-name>`.

For example, if the project's nav structure is under `business-central/`:
```bash
bun run src/sync-nav.js --all --nav-root business-central --concurrency 100
```

The wiki path prefix defaults to the folder name, but can be overridden:
```bash
bun run src/sync-nav.js --all --nav-root business-central --wiki-prefix docs --concurrency 100
```

### Workflow

When a user asks to sync a navigation tree:
1. **Ask for the nav folder name** (e.g., "business-central", "docs", "guides")
2. Ask for `WIKIJS_URL` and auth if not already configured
3. Scan the folder and report the tree structure
4. Run `--all --nav-root <folder>` (dry-run first)
5. Confirm with user, then run with `--concurrency 100`

## Combined Workflow — Sync Everything

When a user wants to sync an entire documentation project:
1. Ask for the nav folder name (if applicable)
2. Run all three syncs in order: assets → pages → nav
3. Each runs dry-run first, then push with `--concurrency 100` after confirmation

## Error Handling

- If `404` errors appear, verify the `WIKIJS_URL` and auth
- If uploads fail with `413` (too large), the Wiki.js server may have size limits
- Log files are written to `sync_assets.log`, `sync_pages.log`, `sync_nav.log`
- Dry-run mode (no actual push) shows what WOULD happen without making changes

## Directory Layout for a Wiki.js Project

```
my-wiki-docs/
├── .env                  # WIKIJS_URL, WIKIJS_USERNAME, WIKIJS_PASSWORD, WIKIJS_STRATEGY
├── assets/               # Images, files → wiki folder 1
│   ├── <uuid1>.png
│   └── <uuid2>.pdf
├── pages/                # Content pages → wiki path pages/<uuid>
│   ├── <uuid1>.md
│   └── <uuid2>.md
└── <nav-folder>/         # Navigation tree README.md files
    ├── README.md
    ├── chapter1/
    │   └── README.md
    └── chapter2/
        └── README.md
```
