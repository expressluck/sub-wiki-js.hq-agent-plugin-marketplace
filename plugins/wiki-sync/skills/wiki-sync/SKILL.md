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

This plugin provides three Python sync scripts for pushing content to a Wiki.js
instance. All scripts require the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `WIKI_URL` | Yes | Wiki.js base URL (e.g. `https://wiki.example.com`) |
| `WIKI_API_KEY` | Preferred | API bearer token for authentication |
| `WIKI_EMAIL` | Fallback | Email for login (requires WIKI_PASSWORD) |
| `WIKI_PASSWORD` | Fallback | Password for login |
| `WIKI_LOCALE` | No | Content locale (default: `en`) |

The scripts use `uv run` via the `pyproject.toml` in the plugin's `src/`
directory. Commands should be run from that directory (or with `--directory`).

## Prerequisites

```bash
# Install dependencies (run once)
uv sync --directory "<plugin-path>/plugins/wiki-sync/src"
```

## Script 1: sync-assets — Upload Files to Wiki.js

Uploads all files from a local `assets/` directory to a Wiki.js asset folder.
Each filename is `<uuid>.<ext>` (e.g. `bd223c82-b1b7-407b-8eb9-0ac4fc330d8f.png`).

### Modes

| Mode | Command | Purpose |
|------|---------|---------|
| Full sync | `uv run --directory "<path>" wiki-sync sync-assets --all` | Upload all files not yet on server |
| Full sync (push) | `uv run --directory "<path>" wiki-sync sync-assets --all --yes` | Actually upload |
| Single file | `uv run --directory "<path>" wiki-sync sync-assets --file PATH` | Upload one file |
| Single file (rename) | `uv run --directory "<path>" wiki-sync sync-assets --file PATH --as UUID.ext` | Upload with custom remote name |
| List remote | `uv run --directory "<path>" wiki-sync sync-assets --list` | Show files on server |

### Options

- `--assets-dir PATH` — Local assets directory (default: `assets`)
- `--folder-id ID` — Wiki.js folder ID (default: `1`)
- `--yes` — Actually perform uploads; omit for dry-run

### Workflow

When a user asks to sync assets:
1. Ask for `WIKI_URL` and auth if not already configured
2. Check that the assets directory exists and contains files
3. Run `--all` (dry-run first) to see what will be uploaded
4. Confirm with user, then run with `--yes`

## Script 2: sync-pages — Push Markdown Pages

Syncs `.md` files from a local `pages/` directory to Wiki.js. Each file is
named `<uuid>.md` (32 hex chars, no dashes) and is pushed to path
`pages/<uuid>` (no `.md` extension).

### Modes

| Mode | Command | Purpose |
|------|---------|---------|
| Full sync | `uv run --directory "<path>" wiki-sync sync-pages --all` | Sync all .md files |
| Full sync (push) | `uv run --directory "<path>" wiki-sync sync-pages --all --yes` | Actually push |
| Single page | `uv run --directory "<path>" wiki-sync sync-pages --page UUID` | Sync one page |
| Single page (push) | `uv run --directory "<path>" wiki-sync sync-pages --page UUID --yes` | Actually push |
| List remote | `uv run --directory "<path>" wiki-sync sync-pages --list` | Show pages on server |

### Options

- `--pages-dir PATH` — Local pages directory (default: `pages`)
- `--yes` — Actually push changes; omit for dry-run

### Page Title

The page title is extracted from the first `# Heading` in the markdown content.
If no heading is found, the uuid is used as the title.

### Workflow

When a user asks to sync pages:
1. Ask for `WIKI_URL` and auth if not already configured
2. Scan the pages directory and report count
3. Run `--all` (dry-run first) to preview changes
4. Confirm with user, then run with `--yes`

## Script 3: sync-nav — Build Navigation Tree

Builds a navigation hierarchy from `README.md` files under a configurable
folder (default: `nav/`). Each `README.md` becomes a folder page on Wiki.js:

```
nav/README.md          → wiki path: "nav"
nav/foo/README.md      → wiki path: "nav/foo"
nav/foo/bar/README.md  → wiki path: "nav/foo/bar"
```

### Modes

| Mode | Command | Purpose |
|------|---------|---------|
| Full sync | `uv run --directory "<path>" wiki-sync sync-nav --all` | Sync all README.md files |
| Full sync (push) | `uv run --directory "<path>" wiki-sync sync-nav --all --yes` | Actually push |
| Single page | `uv run --directory "<path>" wiki-sync sync-nav --rel ""` | Sync root README |
| Single page | `uv run --directory "<path>" wiki-sync sync-nav --rel "path/to/folder"` | Sync specific folder |
| Single push | `uv run --directory "<path>" wiki-sync sync-nav --rel "" --yes` | Push specific page |
| List remote | `uv run --directory "<path>" wiki-sync sync-nav --list` | Show nav pages on server |

### Options

- `--nav-root PATH` — Local nav root folder (default: `nav`)
- `--wiki-prefix PREFIX` — Wiki.js path prefix (default: nav-root folder name)
- `--yes` — Actually push changes; omit for dry-run

### Important: Nav Folder is Configurable

The navigation root folder is NOT hardcoded. **Always ask the user which
folder contains their navigation README.md files.** Then set it with
`--nav-root <folder-name>`.

For example, if the project's nav structure is under `business-central/`:
```bash
uv run --directory "<path>" wiki-sync sync-nav --all --nav-root business-central --yes
```

The wiki path prefix defaults to the folder name, but can be overridden:
```bash
uv run --directory "<path>" wiki-sync sync-nav --all --nav-root business-central --wiki-prefix docs --yes
```

### Workflow

When a user asks to sync a navigation tree:
1. **Ask for the nav folder name** (e.g., "business-central", "docs", "guides")
2. Ask for `WIKI_URL` and auth if not already configured
3. Scan the folder and report the tree structure
4. Run `--all --nav-root <folder>` (dry-run first)
5. Confirm with user, then run with `--yes`

## Combined Workflow — Sync Everything

When a user wants to sync an entire documentation project:
1. Ask for the nav folder name (if applicable)
2. Run all three syncs in order: assets → pages → nav
3. Each runs dry-run first, then push with `--yes` after confirmation

## Error Handling

- If `404` errors appear, verify the `WIKI_URL` and auth
- If uploads fail with `413` (too large), the Wiki.js server may have size limits
- Log files are written to `sync_assets.log`, `sync_pages.log`, `sync_nav.log`
- Dry-run mode (no `--yes`) shows what WOULD happen without making changes

## Directory Layout for a Wiki.js Project

```
my-wiki-docs/
├── .env                  # WIKI_URL, WIKI_API_KEY, WIKI_LOCALE
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
