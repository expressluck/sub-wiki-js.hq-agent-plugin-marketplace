"""Sync assets to Wiki.js.

Assets are uploaded to a Wiki.js folder (default folderId=1) via the /u endpoint.
Each asset filename is a UUID + extension (e.g. bd223c82-b1b7-407b-8eb9-0ac4fc330d8f.png).

Modes:
  --all           Full sync: scan assets/ directory, upload all files that aren't
                  already on the server.
  --file PATH     Single sync: upload a single local file (can also specify a
                  custom remote UUID name with --as).
  --list          List assets on the server.

Examples:
  # Full sync (dry-run)
  python sync_assets.py --all

  # Full sync (actually upload)
  python sync_assets.py --all --yes

  # Single file
  python sync_assets.py --file assets/bd223c82-b1b7-407b-8eb9-0ac4fc330d8f.png --yes

  # Single file with custom remote name
  python sync_assets.py --file ./my_image.png --as abc123-def456.png --yes

  # List what's on the server
  python sync_assets.py --list
"""

import argparse
import json
import time
from pathlib import Path

from .wiki_api import login, list_assets, upload_asset, delete_asset  # noqa: F401

DEFAULT_ASSETS_DIR = Path("assets")
DEFAULT_FOLDER_ID = 1
LOG_PATH = "sync_assets.log"


def _ext_to_kind(ext: str) -> str:
    """Guess a rough kind string for logging (not used by the API)."""
    ext = ext.lower()
    if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}:
        return "image"
    if ext in {".pdf"}:
        return "doc"
    if ext in {".xlsx", ".xls", ".csv"}:
        return "spreadsheet"
    return "binary"


def full_sync(
    jwt: str,
    yes: bool,
    assets_dir: Path = DEFAULT_ASSETS_DIR,
    folder_id: int = DEFAULT_FOLDER_ID,
):
    """Scan assets_dir/ and upload any missing files to the server."""
    if not assets_dir.exists():
        raise SystemExit(f"Assets directory not found: {assets_dir}")

    local_files = sorted(p for p in assets_dir.iterdir() if p.is_file())
    print(f"Local assets: {len(local_files)} files in {assets_dir}/")

    # Get existing assets on the server
    remote = list_assets(jwt, folder_id=folder_id)
    remote_names = {a["filename"] for a in remote}
    print(f"Remote assets (folderId={folder_id}): {len(remote_names)} files")

    # Determine which files to upload
    to_upload = []
    for fp in local_files:
        if fp.name in remote_names:
            continue
        to_upload.append(fp)

    if not to_upload:
        print("All assets already synced. Nothing to do.")
        return

    print(f"\nTo upload: {len(to_upload)} files")
    for fp in to_upload[:10]:
        print(f"  {fp.name}  ({fp.stat().st_size:,} bytes)")
    if len(to_upload) > 10:
        print(f"  ... and {len(to_upload) - 10} more")

    if not yes:
        print("\n[DRY-RUN] Re-run with --yes to upload.")
        return

    # Upload
    ok = fail = 0
    log_lines = []
    t0 = time.time()
    for i, fp in enumerate(to_upload, 1):
        result = upload_asset(jwt, str(fp), fp.name, folder_id=folder_id)
        if result["ok"]:
            ok += 1
            print(f"  [{i}/{len(to_upload)}] OK  {fp.name}")
        else:
            fail += 1
            print(
                f"  [{i}/{len(to_upload)}] FAIL  {fp.name}  "
                f"status={result['status_code']}  {result['body'][:120]}"
            )
        log_lines.append(json.dumps({
            "file": fp.name,
            "ok": result["ok"],
            "status": result["status_code"],
            "body": result["body"][:200],
        }, ensure_ascii=False))
        time.sleep(0.05)

    with open(LOG_PATH, "w", encoding="utf-8") as lf:
        lf.write("\n".join(log_lines) + "\n")

    elapsed = time.time() - t0
    print(f"\nDone. ok={ok} fail={fail}  elapsed={elapsed:.1f}s  log={LOG_PATH}")


def single_sync(
    jwt: str,
    file_path: str,
    remote_name: str | None,
    yes: bool,
    folder_id: int = DEFAULT_FOLDER_ID,
):
    """Upload a single file."""
    fp = Path(file_path)
    if not fp.exists():
        raise SystemExit(f"File not found: {fp}")
    if not fp.is_file():
        raise SystemExit(f"Not a file: {fp}")

    name = remote_name if remote_name else fp.name

    print(f"Source : {fp}  ({fp.stat().st_size:,} bytes)")
    print(f"Remote : {name}  (folderId={folder_id})")

    if not yes:
        print("\n[DRY-RUN] Re-run with --yes to upload.")
        return

    result = upload_asset(jwt, str(fp), name, folder_id=folder_id)
    if result["ok"]:
        print(f"OK  uploaded {name}")
    else:
        print(f"FAIL  status={result['status_code']}  {result['body'][:200]}")
        raise SystemExit(1)


def list_remote_assets(jwt: str, folder_id: int = DEFAULT_FOLDER_ID):
    """Print all assets currently on the server."""
    assets = list_assets(jwt, folder_id=folder_id)
    print(f"Asset folder id={folder_id}: {len(assets)} files\n")
    for a in assets:
        print(
            f"  id={str(a.get('id','?')):>5}  {a.get('filename','?'):<50}  "
            f"ext={a.get('ext','?'):<6}  kind={a.get('kind','?'):<10}  "
            f"size={str(a.get('fileSize', '?')):>10}"
        )
    # Stats
    exts = {}
    for a in assets:
        e = a.get("ext", "?")
        exts[e] = exts.get(e, 0) + 1
    print(f"\nBy extension: {exts}")


def run(args: argparse.Namespace):
    """Entry point for sync_assets module."""
    if args.list:
        jwt = login()
        list_remote_assets(jwt, folder_id=getattr(args, "folder_id", DEFAULT_FOLDER_ID))
        return

    if args.file:
        jwt = login()
        single_sync(
            jwt,
            args.file,
            getattr(args, "as", None),
            args.yes,
            folder_id=getattr(args, "folder_id", DEFAULT_FOLDER_ID),
        )
        return

    if args.all:
        jwt = login()
        full_sync(
            jwt,
            args.yes,
            assets_dir=Path(getattr(args, "assets_dir", DEFAULT_ASSETS_DIR)),
            folder_id=getattr(args, "folder_id", DEFAULT_FOLDER_ID),
        )
        return


def add_arguments(ap: argparse.ArgumentParser):
    """Add asset-sync-specific arguments to a parent parser or subparser."""
    ap.add_argument("--all", action="store_true",
                    help="Full sync: upload all assets from assets/")
    ap.add_argument("--file", default=None, metavar="PATH",
                    help="Single sync: upload one file")
    ap.add_argument("--as", default=None, metavar="UUID.EXT",
                    help="Remote filename to use with --file")
    ap.add_argument("--list", action="store_true",
                    help="List assets currently on the server")
    ap.add_argument("--yes", action="store_true",
                    help="Actually perform uploads (omit for dry-run)")
    ap.add_argument("--assets-dir", default=str(DEFAULT_ASSETS_DIR), metavar="PATH",
                    help=f"Local assets directory (default: {DEFAULT_ASSETS_DIR})")
    ap.add_argument("--folder-id", type=int, default=DEFAULT_FOLDER_ID, metavar="ID",
                    help=f"Wiki.js asset folder ID (default: {DEFAULT_FOLDER_ID})")


def main():
    ap = argparse.ArgumentParser(
        description="Sync assets to Wiki.js",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    add_arguments(ap)
    args = ap.parse_args()

    if args.list or args.file or args.all:
        run(args)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
