"""Sync a navigation tree to Wiki.js from a folder of README.md files.

The navigation tree is defined by README.md files under a configurable root
directory (default: "nav/"). Each README.md maps to a folder page in Wiki.js:

  <nav_root>/README.md            → wiki page "<nav_root>"
  <nav_root>/foo/README.md        → wiki page "<nav_root>/foo"
  <nav_root>/foo/bar/README.md    → wiki page "<nav_root>/foo/bar"

These folder pages form the navigation hierarchy. Actual content pages live
under pages/<uuid> and are synced separately by sync_pages.py.

Modes:
  --all             Full sync: scan <nav_root>/ for README.md files,
                    create/update all folder pages.
  --rel PATH        Single sync: sync one README.md by its path relative to
                    <nav_root>/ (e.g. "chapter/guide" or just "" for root).
  --list            List nav pages on the server.

Examples:
  # Full sync (dry-run)
  python sync_nav.py --all

  # Full sync (push)
  python sync_nav.py --all --yes

  # Sync with a custom nav root
  python sync_nav.py --all --nav-root my-project --yes

  # Single folder page (dry-run)
  python sync_nav.py --rel "chapter/guide"

  # Root README (dry-run)
  python sync_nav.py --rel ""

  # Push a single folder
  python sync_nav.py --rel "chapter/guide" --yes

  # List folder pages on the server
  python sync_nav.py --list
"""

import argparse
import json
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

DEFAULT_NAV_ROOT = Path("nav")
LOG_PATH = "sync_nav.log"
SKIP_FILES = set()


def _title_from_content(content: str, fallback: str) -> str:
    """Extract the first # heading from markdown content."""
    for line in content.splitlines():
        s = line.strip()
        if s.startswith("# "):
            t = s[2:].strip()
            if t:
                return t
    return fallback


def _rel_to_path(rel: Path, wiki_prefix: str) -> str:
    """Map a README.md relative path to a wiki page path.

    README.md collapses to its parent folder:
      ""            (root README)  → "<wiki_prefix>"
      "foo/README.md"              → "<wiki_prefix>/foo"
      "foo/bar/README.md"          → "<wiki_prefix>/foo/bar"
    """
    parts = [p for p in rel.with_suffix("").parts if p]
    # Drop trailing "README" — the page IS the folder.
    if parts and parts[-1].lower() == "readme":
        parts = parts[:-1]
    if not parts:
        return wiki_prefix
    return wiki_prefix + "/" + "/".join(parts)


def _rel_to_title(rel: Path, wiki_prefix: str) -> str:
    """Derive a fallback title from the relative path.

    Uses the deepest folder name as the page title.
    """
    parts = [p for p in rel.with_suffix("").parts if p]
    if parts and parts[-1].lower() == "readme":
        parts = parts[:-1]
    if not parts:
        return wiki_prefix
    return parts[-1]


def _scan_nav_dir(nav_root: Path):
    """Yield (rel_path, abs_path, content) for each README.md under nav_root."""
    if not nav_root.exists():
        print(f"WARNING: navigation directory not found: {nav_root}")
        return
    for fp in sorted(nav_root.rglob("*.md")):
        rel = fp.relative_to(nav_root)
        if rel.name in SKIP_FILES:
            continue
        if rel.name.lower() != "readme.md":
            continue
        try:
            content = fp.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  ERROR reading {fp}: {e}", file=sys.stderr)
            continue
        yield (rel, fp, content)


def full_sync(jwt: str, yes: bool, nav_root: Path = DEFAULT_NAV_ROOT, wiki_prefix: str = ""):
    """Discover all README.md files and sync them as folder pages."""
    prefix = wiki_prefix or nav_root.name

    items = list(_scan_nav_dir(nav_root))
    print(f"Discovered {len(items)} folder page(s) in {nav_root}/")
    for rel, fp, content in items[:15]:
        path = _rel_to_path(rel, prefix)
        title = _title_from_content(content, _rel_to_title(rel, prefix))
        print(f"  {rel}  ->  {path}  ({title!r})")
    if len(items) > 15:
        print(f"  ... and {len(items) - 15} more")

    if not yes:
        print("\n[DRY-RUN] Re-run with --yes to push.")
        return

    ok = created = updated = fail = 0
    log_lines = []
    t0 = time.time()

    for i, (rel, fp, content) in enumerate(items, 1):
        path = _rel_to_path(rel, prefix)
        title = _title_from_content(content, _rel_to_title(rel, prefix))
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
                "rel": str(rel),
                "path": path,
                "title": title,
                "action": action,
                "result": rr,
                "errors": data.get("errors"),
            }, ensure_ascii=False))

            if i % 5 == 0 or i == len(items):
                print(
                    f"  {i}/{len(items)}  ok={ok} fail={fail}  "
                    f"new={created} upd={updated}  "
                    f"elapsed={time.time() - t0:.1f}s",
                    flush=True,
                )
        except Exception as e:
            fail += 1
            log_lines.append(json.dumps({
                "rel": str(rel),
                "path": path,
                "title": title,
                "action": "EXC",
                "error": str(e),
            }, ensure_ascii=False))
            print(f"  ERROR {rel}: {e}", flush=True)

        time.sleep(0.05)

    with open(LOG_PATH, "w", encoding="utf-8") as lf:
        lf.write("\n".join(log_lines) + "\n")

    elapsed = time.time() - t0
    print(
        f"\nDone. ok={ok} (new={created}, upd={updated}) fail={fail}  "
        f"elapsed={elapsed:.1f}s  log={LOG_PATH}"
    )


def single_sync(
    jwt: str,
    rel_str: str,
    yes: bool,
    nav_root: Path = DEFAULT_NAV_ROOT,
    wiki_prefix: str = "",
):
    """Sync a single README.md by its relative path."""
    prefix = wiki_prefix or nav_root.name

    # Normalize: empty string = root README
    if rel_str in ("", "."):
        fp = nav_root / "README.md"
        rel = Path("README.md")
    else:
        # Try as a folder path (look for README.md inside)
        fp = nav_root / rel_str / "README.md"
        if not fp.exists():
            # Try as a direct file path
            fp = nav_root / rel_str
        rel = fp.relative_to(nav_root) if fp.exists() else Path(rel_str)

    if not fp.exists():
        raise SystemExit(f"README.md not found at: {fp}")

    if fp.name.lower() != "readme.md":
        print(f"WARNING: {fp.name} is not README.md — treating as nav page anyway.")

    content = fp.read_text(encoding="utf-8")
    path = _rel_to_path(rel, prefix)
    title = _title_from_content(content, _rel_to_title(rel, prefix))

    print(f"Source : {fp}")
    print(f"Path   : {path}")
    print(f"Title  : {title}")

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


def list_nav_pages(jwt: str, wiki_prefix: str | None = None):
    """List folder/nav pages on the server."""
    all_pages = list_pages(jwt, locale=LOCALE)
    if wiki_prefix:
        nav = [p for p in all_pages if (p.get("path") or "").startswith(wiki_prefix)]
        print(f"Navigation pages under '{wiki_prefix}/' (locale={LOCALE}): {len(nav)}\n")
    else:
        nav = all_pages
        print(f"All pages (locale={LOCALE}): {len(nav)}\n")
    for p in sorted(nav, key=lambda x: x.get("path", "")):
        print(
            f"  id={str(p['id']):>5}  path={p['path']:<50}  "
            f"published={p.get('isPublished')}  "
            f"title={p.get('title', '')[:50]!r}"
        )


def add_arguments(ap: argparse.ArgumentParser):
    """Add nav-sync-specific arguments to a parent parser or subparser."""
    ap.add_argument("--all", action="store_true",
                    help="Full sync: sync all README.md under nav-root/")
    ap.add_argument("--rel", default=None, metavar="PATH",
                    help="Single sync: path relative to nav-root/ "
                         "(empty string for root)")
    ap.add_argument("--list", action="store_true",
                    help="List navigation pages on the server")
    ap.add_argument("--yes", action="store_true",
                    help="Actually push changes (omit for dry-run)")
    ap.add_argument("--nav-root", default=str(DEFAULT_NAV_ROOT), metavar="PATH",
                    help=f"Local navigation root folder (default: {DEFAULT_NAV_ROOT})")
    ap.add_argument("--wiki-prefix", default="", metavar="PREFIX",
                    help="Wiki.js path prefix for nav pages "
                         "(default: the nav-root folder name)")


def run(args: argparse.Namespace):
    """Entry point for sync_nav module."""
    if args.list:
        jwt = login()
        list_nav_pages(
            jwt,
            wiki_prefix=getattr(args, "wiki_prefix", "") or None,
        )
        return

    nav_root = Path(getattr(args, "nav_root", DEFAULT_NAV_ROOT))
    wiki_prefix = getattr(args, "wiki_prefix", "") or nav_root.name

    if args.rel is not None:
        jwt = login()
        single_sync(jwt, args.rel, args.yes, nav_root=nav_root, wiki_prefix=wiki_prefix)
        return

    if args.all:
        jwt = login()
        full_sync(jwt, args.yes, nav_root=nav_root, wiki_prefix=wiki_prefix)
        return


def main():
    ap = argparse.ArgumentParser(
        description="Sync navigation tree to Wiki.js",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    add_arguments(ap)
    args = ap.parse_args()

    if args.list or args.rel is not None or args.all:
        run(args)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
