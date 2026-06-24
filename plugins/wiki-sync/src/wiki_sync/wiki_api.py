"""Wiki.js API client.

Authentication via environment variables:
  WIKI_URL       — Base URL of the Wiki.js instance (required)
                   e.g. https://wiki.example.com
  WIKI_API_KEY   — API bearer token (preferred)
  WIKI_EMAIL     — Email for login (fallback; requires WIKI_PASSWORD)
  WIKI_PASSWORD  — Password for login (fallback)
  WIKI_LOCALE    — Content locale (default: "en")

Uses the Wiki.js GraphQL API for pages and REST endpoints for assets.
"""

import os
import json
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

# Load .env from current directory if present
load_dotenv()

WIKI_URL = os.getenv("WIKI_URL", "").rstrip("/")
WIKI_API_KEY = os.getenv("WIKI_API_KEY", "")
WIKI_EMAIL = os.getenv("WIKI_EMAIL", "")
WIKI_PASSWORD = os.getenv("WIKI_PASSWORD", "")
LOCALE = os.getenv("WIKI_LOCALE", "en")

# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

_SESSION: requests.Session | None = None


def _session() -> requests.Session:
    """Return a persistent requests.Session with auth headers set."""
    global _SESSION
    if _SESSION is not None:
        return _SESSION

    if not WIKI_URL:
        raise SystemExit(
            "WIKI_URL is not set. Please set the WIKI_URL environment variable.\n"
            "Example: WIKI_URL=https://wiki.example.com"
        )

    sess = requests.Session()

    if WIKI_API_KEY:
        sess.headers["Authorization"] = f"Bearer {WIKI_API_KEY}"
    else:
        _login_via_graphql(sess)

    _SESSION = sess
    return _SESSION


def _login_via_graphql(sess: requests.Session) -> None:
    """Authenticate via the Wiki.js GraphQL login mutation."""
    if not WIKI_EMAIL or not WIKI_PASSWORD:
        raise SystemExit(
            "Authentication required. Set either:\n"
            "  WIKI_API_KEY=<your-api-token>\n"
            "  or both WIKI_EMAIL=<email> and WIKI_PASSWORD=<password>"
        )

    query = """
    mutation($email: String!, $password: String!) {
      authentication {
        login(email: $email, password: $password) {
          jwt
        }
      }
    }
    """
    resp = sess.post(
        f"{WIKI_URL}/graphql",
        json={"query": query, "variables": {"email": WIKI_EMAIL, "password": WIKI_PASSWORD}},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    jwt = data.get("data", {}).get("authentication", {}).get("login", {}).get("jwt")
    if not jwt:
        errors = data.get("errors", [])
        msg = "; ".join(e.get("message", str(e)) for e in errors)
        raise SystemExit(f"Wiki.js login failed: {msg or 'no JWT returned'}")
    sess.headers["Authorization"] = f"Bearer {jwt}"


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def login() -> str:
    """Ensure we have a session and return the Authorization header value.

    Returns the bare JWT token string (without 'Bearer ' prefix).
    This preserves the original sync script interface.
    """
    sess = _session()
    auth = sess.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return auth


def _gql(query: str, variables: dict | None = None) -> dict[str, Any]:
    """Execute a GraphQL query/mutation and return the JSON response."""
    sess = _session()
    payload: dict[str, Any] = {"query": query}
    if variables:
        payload["variables"] = variables
    resp = sess.post(f"{WIKI_URL}/graphql", json=payload, timeout=60)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Page API (GraphQL)
# ---------------------------------------------------------------------------

def find_page_by_path(jwt: str, path: str) -> dict[str, Any] | None:
    """Look up a page by its wiki path. Returns the page dict or None."""
    query = """
    query($path: String!, $locale: String!) {
      pages {
        search(query: $path, locale: $locale) {
          id
          path
          title
          isPublished
        }
      }
    }
    """
    result = _gql(query, {"path": path, "locale": LOCALE})
    pages = result.get("data", {}).get("pages", {}).get("search", [])
    # search may return fuzzy results — find exact path match
    if isinstance(pages, list):
        for p in pages:
            if p.get("path") == path:
                return p
    return None


def list_pages(jwt: str, locale: str = "") -> list[dict[str, Any]]:
    """Return all pages for the given locale."""
    loc = locale or LOCALE
    query = """
    query($locale: String!) {
      pages {
        list(locale: $locale) {
          id
          path
          title
          isPublished
          locale
          updatedAt
        }
      }
    }
    """
    result = _gql(query, {"locale": loc})
    return result.get("data", {}).get("pages", {}).get("list", [])


def create_page(
    jwt: str,
    path: str,
    title: str,
    content: str,
    description: str = "",
    locale: str = "",
) -> dict[str, Any]:
    """Create a new page at the given path. Returns the full GraphQL response."""
    loc = locale or LOCALE
    mutation = """
    mutation($path: String!, $title: String!, $content: String!,
             $description: String!, $locale: String!) {
      pages {
        create(
          path: $path,
          title: $title,
          content: $content,
          description: $description,
          locale: $locale,
          editor: "markdown",
          isPublished: true
        ) {
          responseResult {
            succeeded
            errorCode
            slug
            message
          }
          page {
            id
            path
            title
            locale
          }
        }
      }
    }
    """
    variables = {
        "path": path,
        "title": title,
        "content": content,
        "description": description,
        "locale": loc,
    }
    return _gql(mutation, variables)


def update_page(
    jwt: str,
    page_id: int,
    title: str,
    content: str,
    description: str = "",
) -> dict[str, Any]:
    """Update an existing page by its numeric ID."""
    mutation = """
    mutation($id: Int!, $title: String!, $content: String!,
             $description: String!) {
      pages {
        update(
          id: $id,
          title: $title,
          content: $content,
          description: $description,
          editor: "markdown",
          isPublished: true
        ) {
          responseResult {
            succeeded
            errorCode
            slug
            message
          }
          page {
            id
            path
            title
          }
        }
      }
    }
    """
    variables = {
        "id": page_id,
        "title": title,
        "content": content,
        "description": description,
    }
    return _gql(mutation, variables)


# ---------------------------------------------------------------------------
# Asset API (REST)
# ---------------------------------------------------------------------------

def list_assets(jwt: str, folder_id: int = 1) -> list[dict[str, Any]]:
    """List all assets in a folder. Uses the Wiki.js `/a` REST endpoint."""
    sess = _session()
    resp = sess.get(
        f"{WIKI_URL}/a",
        params={"f": folder_id},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    # Response is typically an array/object with a 'files' key or a flat list
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("files", data.get("assets", []))
    return []


def upload_asset(
    jwt: str,
    file_path: str,
    remote_name: str,
    folder_id: int = 1,
) -> dict[str, Any]:
    """Upload a file to the specified Wiki.js asset folder.

    Returns: {"ok": bool, "status_code": int, "body": str}
    """
    sess = _session()
    fp = Path(file_path)
    if not fp.exists():
        return {"ok": False, "status_code": 0, "body": f"File not found: {file_path}"}

    try:
        with open(fp, "rb") as fh:
            resp = sess.post(
                f"{WIKI_URL}/u",
                files={"mediaUpload": (remote_name, fh)},
                data={"folderId": folder_id},
                timeout=120,
            )
        status = resp.status_code
        try:
            body = resp.text
        except Exception:
            body = str(status)
        return {
            "ok": status in (200, 201),
            "status_code": status,
            "body": body[:2000],
        }
    except Exception as exc:
        return {"ok": False, "status_code": 0, "body": str(exc)[:2000]}


def delete_asset(jwt: str, asset_id: int) -> dict[str, Any]:
    """Delete an asset by its numeric ID."""
    sess = _session()
    resp = sess.delete(f"{WIKI_URL}/a/{asset_id}", timeout=30)
    try:
        body = resp.text
    except Exception:
        body = str(resp.status_code)
    return {"ok": resp.status_code in (200, 204), "status_code": resp.status_code, "body": body[:2000]}
