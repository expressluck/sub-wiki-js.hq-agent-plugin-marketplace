"""Unified CLI for Wiki.js content sync.

Usage:
  wiki-sync sync-assets --all [--yes]           # Full asset sync
  wiki-sync sync-assets --file PATH [--yes]      # Single asset upload
  wiki-sync sync-assets --list                   # List remote assets

  wiki-sync sync-pages --all [--yes]             # Full page sync
  wiki-sync sync-pages --page UUID [--yes]       # Single page sync
  wiki-sync sync-pages --list                    # List remote pages

  wiki-sync sync-nav --all [--yes]               # Full nav sync
  wiki-sync sync-nav --rel PATH [--yes]          # Single nav page sync
  wiki-sync sync-nav --list                      # List remote nav pages
"""

import argparse
import sys

from . import sync_assets, sync_pages, sync_nav


def cmd_sync_assets(args: argparse.Namespace) -> None:
    sync_assets.run(args)


def cmd_sync_pages(args: argparse.Namespace) -> None:
    sync_pages.run(args)


def cmd_sync_nav(args: argparse.Namespace) -> None:
    sync_nav.run(args)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Wiki.js content sync toolkit",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = ap.add_subparsers(dest="command", title="commands")

    # sync-assets
    ap_assets = sub.add_parser(
        "sync-assets",
        help="Sync files to Wiki.js assets folder",
        description=sync_assets.__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sync_assets.add_arguments(ap_assets)

    # sync-pages
    ap_pages = sub.add_parser(
        "sync-pages",
        help="Sync markdown pages to Wiki.js",
        description=sync_pages.__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sync_pages.add_arguments(ap_pages)

    # sync-nav
    ap_nav = sub.add_parser(
        "sync-nav",
        help="Sync navigation tree to Wiki.js",
        description=sync_nav.__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sync_nav.add_arguments(ap_nav)

    args = ap.parse_args()

    if args.command == "sync-assets":
        cmd_sync_assets(args)
    elif args.command == "sync-pages":
        cmd_sync_pages(args)
    elif args.command == "sync-nav":
        cmd_sync_nav(args)
    else:
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
