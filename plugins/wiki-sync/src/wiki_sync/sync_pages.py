"""Sync pages to Wiki.js.

Pages are individual .md files stored under a pages/ directory locally.
On Wiki.js they live at path "pages/<uuid>" (no .md extension, uuid without dashes).

The uuid is the 32-char hex stem of the filename (without the .md extension).
For example: pages/e5555cd246cb4c57b3221997b85a38c9.md → wiki path pages/e5555cd246cb4c57b3221997b85a38c9

Modes:
  --all          Full sync: scan pages/ directory, sync all .md files.
  --page UUID    Single sync: sync one page by its uuid (32 hex chars, no dashes).
                 The file must exist at pages/<uuid>.md .
  --list         List pages on the server.

Examples:
  # Full sync (dry-run)
  python sync_pages.py --all

  # Full sync (actually push)
  python sync_pages.py --all --yes

  # Single page (dry-run)
  python sync_pages.py --page e5555cd246cb4c57b3221997b85a38c9

  # Single page (push)
  python sync_pages.py --page e5555cd246cb4c57b3221997b85a38c9 --yes

  # List pages on the server
  python sync_pages.py --list
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

from .wiki_api import (
    LOCALE,
    login,
    find_page_by_path,
    create_page,
    update_page,
    list_pages,
)

DEFAULT_PAGES_DIR = Path("pages")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
LOG_PATH = "sync_pages.log"


def _title_from_content(content: str, fallback: str) -> str:
    """Extract the first # heading from markdown content as the page title."""
    for line in content.splitlines():
        s = line.strip()
        if s.startswith("# "):
            t = s[2:].strip()
            if t:
                return t
    return fallback


def _page_path(uuid: str) -> str:
    """Build the wiki path for a page uuid (without dashes)."""
    return f"pages/{uuid}"


def _scan_pages_dir(pages_dir: Path = DEFAULT_PAGES_DIR):
    """Yield (uuid, file_path, content) for valid pages in pages_dir/."""
    if not pages_dir.exists():
        print(f"WARNING: pages directory not found: {pages_dir}")
        return
    for fp in sorted(pages_dir.glob("*.md")):
        stem = fp.stem
        if not HEX32.match(stem):
            print(f"  WARN: skipping non-uuid file: {fp.name}")
            continue
        try:
            content = fp.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  ERROR reading {fp}: {e}", file=sys.stderr)
            continue
        yield (stem, fp, content)


def full_sync(jwt: str, yes: bool, pages_dir: Path = DEFAULT_PAGES_DIR):
    """Discover all pages_dir/ .md files and sync them to Wiki.js."""
    items = list(_scan_pages_dir(pages_dir))
    print(f"Discovered {len(items)} page(s) in {pages_dir}/")
    for uuid, fp, content in items[:10]:
        title = _title_from_content(content, uuid)
        print(f"  {uuid[:8]}…  ->  {_page_path(uuid)}  ({title!r})")
    if len(items) > 10:
        print(f"  ... and {len(items) - 10} more")

    if not yes:
        print("\n[DRY-RUN] Re-run with --yes to push.")
        return

    ok = created = updated = fail = 0
    log_lines = []
    t0 = time.time()

    for i, (uuid, fp, content) in enumerate(items, 1):
        title = _title_from_content(content, uuid)
        path = _page_path(uuid)
        description = title[:200]

        try:
            existing = find_page_by_path(jwt, path)
            if existing and existing.get("id"):
                data = update_page(
                    jwt,
                    page_id=existing["id"],
                    title=title,
                    content=content,
                    description=description,
                )
                resp = data.get("data", {}).get("pages", {}).get("update", {})
                rr = resp.get("responseResult", {})
                if rr.get("succeeded"):
                    updated += 1
                    ok += 1
                    action = "UPD"
                else:
                    fail += 1
                    action = "UPD-FAIL"
            else:
                data = create_page(
                    jwt,
                    path=path,
                    title=title,
                    content=content,
                    description=description,
                )
                resp = data.get("data", {}).get("pages", {}).get("create", {})
                rr = resp.get("responseResult", {})
                if rr.get("succeeded"):
                    created += 1
                    ok += 1
                    action = "NEW"
                else:
                    fail += 1
                    action = "NEW-FAIL"

            log_lines.append(json.dumps({
                "uuid": uuid,
                "path": path,
                "title": title,
                "action": action,
                "result": rr,
                "errors": data.get("errors"),
            }, ensure_ascii=False))

            if i % 10 == 0 or i == len(items):
                print(
                    f"  {i}/{len(items)}  ok={ok} fail={fail}  "
                    f"new={created} upd={updated}  "
                    f"elapsed={time.time() - t0:.1f}s",
                    flush=True,
                )
        except Exception as e:
            fail += 1
            log_lines.append(json.dumps({
                "uuid": uuid,
                "path": path,
                "title": title,
                "action": "EXC",
                "error": str(e),
            }, ensure_ascii=False))
            print(f"  ERROR {uuid[:8]}…: {e}", flush=True)

        time.sleep(0.05)

    with open(LOG_PATH, "w", encoding="utf-8") as lf:
        lf.write("\n".join(log_lines) + "\n")

    elapsed = time.time() - t0
    print(
        f"\nDone. ok={ok} (new={created}, upd={updated}) fail={fail}  "
        f"elapsed={elapsed:.1f}s  log={LOG_PATH}"
    )


def single_sync(jwt: str, uuid: str, yes: bool, pages_dir: Path = DEFAULT_PAGES_DIR):
    """Sync a single page by uuid."""
    if not HEX32.match(uuid):
        raise SystemExit(f"Invalid uuid: {uuid!r} (must be 32 hex chars, no dashes)")

    fp = pages_dir / f"{uuid}.md"
    if not fp.exists():
        raise SystemExit(f"Page file not found: {fp}")

    content = fp.read_text(encoding="utf-8")
    title = _title_from_content(content, uuid)
    path = _page_path(uuid)

    print(f"UUID   : {uuid}")
    print(f"File   : {fp}")
    print(f"Title  : {title}")
    print(f"Path   : {path}")

    if not yes:
        existing = find_page_by_path(jwt, path)
        if existing:
            print(
                f"Status : EXISTS  (id={existing['id']}, "
                f"published={existing.get('isPublished')})"
            )
            print("Action : would UPDATE")
        else:
            print("Status : NEW")
            print("Action : would CREATE")
        print("\n[DRY-RUN] Re-run with --yes to push.")
        return

    existing = find_page_by_path(jwt, path)
    if existing and existing.get("id"):
        print(f"Status : EXISTS (id={existing['id']})  →  UPDATING …")
        data = update_page(
            jwt,
            page_id=existing["id"],
            title=title,
            content=content,
            description=title[:200],
        )
        resp = data.get("data", {}).get("pages", {}).get("update", {})
    else:
        print("Status : NEW  →  CREATING …")
        data = create_page(
            jwt,
            path=path,
            title=title,
            content=content,
            description=title[:200],
        )
        resp = data.get("data", {}).get("pages", {}).get("create", {})

    rr = resp.get("responseResult", {})
    if rr.get("succeeded"):
        page = resp.get("page", {})
        print(f"OK  id={page.get('id')}  path={page.get('path')!r}")
    else:
        errors = data.get("errors", [])
        print(f"FAIL  {rr.get('errorCode')}: {rr.get('message')}")
        if errors:
            for e in errors:
                print(f"  error: {e.get('message', e)}")
        raise SystemExit(1)


def list_remote_pages(jwt: str):
    """List all pages on the server."""
    pages = list_pages(jwt, locale=LOCALE)
    pages_count = len(pages)
    pages_filtered = [p for p in pages if (p.get("path") or "").startswith("pages/")]
    print(f"All pages (locale={LOCALE}): {pages_count}")
    print(f"Pages under pages/: {len(pages_filtered)}\n")
    for p in pages_filtered:
        print(
            f"  id={str(p['id']):>5}  path={p['path']:<60}  "
            f"published={p.get('isPublished')}  "
            f"title={p.get('title', '')[:50]!r}"
        )


def add_arguments(ap: argparse.ArgumentParser):
    """Add page-sync-specific arguments to a parent parser or subparser."""
    ap.add_argument("--all", action="store_true",
                    help="Full sync: sync all pages from pages/")
    ap.add_argument("--page", default=None, metavar="UUID",
                    help="Single sync: sync one page by its 32-char hex uuid")
    ap.add_argument("--list", action="store_true",
                    help="List pages on the server")
    ap.add_argument("--yes", action="store_true",
                    help="Actually push changes (omit for dry-run)")
    ap.add_argument("--pages-dir", default=str(DEFAULT_PAGES_DIR), metavar="PATH",
                    help=f"Local pages directory (default: {DEFAULT_PAGES_DIR})")


def run(args: argparse.Namespace):
    """Entry point for sync_pages module."""
    if args.list:
        jwt = login()
        list_remote_pages(jwt)
        return

    pages_dir = Path(getattr(args, "pages_dir", DEFAULT_PAGES_DIR))

    if args.page:
        jwt = login()
        single_sync(jwt, args.page, args.yes, pages_dir=pages_dir)
        return

    if args.all:
        jwt = login()
        full_sync(jwt, args.yes, pages_dir=pages_dir)
        return


def main():
    ap = argparse.ArgumentParser(
        description="Sync pages to Wiki.js",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    add_arguments(ap)
    args = ap.parse_args()

    if args.list or args.page or args.all:
        run(args)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
