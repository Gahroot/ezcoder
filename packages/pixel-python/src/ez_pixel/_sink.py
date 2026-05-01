"""HTTP sink using stdlib urllib — zero third-party dependencies."""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Optional

from ._types import WireEvent


class HttpSink:
    """POST WireEvents to the pixel-server ingest endpoint.

    Uses ``urllib.request`` so there are no runtime dependencies beyond the
    Python standard library.
    """

    def __init__(self, ingest_url: str) -> None:
        self._url = ingest_url

    def emit(self, event: WireEvent) -> None:
        """Fire-and-forget POST (used by the background drain thread)."""
        self._post(event)

    def emit_sync(self, event: WireEvent) -> None:
        """Blocking POST for fatal errors — same HTTP call, called from the
        foreground thread."""
        self._post(event)

    def close(self) -> None:
        """No-op — urllib has no persistent connection to tear down."""

    # ── internal ──────────────────────────────────────────────────────

    def _post(self, event: WireEvent) -> None:
        payload = json.dumps(_serialize_event(event)).encode("utf-8")
        req = urllib.request.Request(
            self._url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Pixel-Key": event.project_key,
                "User-Agent": "ez-pixel-python/0.1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()  # drain the response
        except (urllib.error.URLError, OSError):
            # Re-raise so the queue's retry logic can kick in.
            raise


def _serialize_event(event: WireEvent) -> dict:
    """Convert a WireEvent dataclass into a JSON-safe dict."""
    return {
        "event_id": event.event_id,
        "project_key": event.project_key,
        "fingerprint": event.fingerprint,
        "type": event.type,
        "message": event.message,
        "stack": [
            {
                "file": f.file,
                "line": f.line,
                "col": f.col,
                "fn": f.fn,
                "in_app": f.in_app,
            }
            for f in event.stack
        ],
        "code_context": (
            {
                "file": event.code_context.file,
                "error_line": event.code_context.error_line,
                "lines": event.code_context.lines,
            }
            if event.code_context is not None
            else None
        ),
        "runtime": event.runtime,
        "manual_report": event.manual_report,
        "level": event.level,
        "occurred_at": event.occurred_at,
    }
