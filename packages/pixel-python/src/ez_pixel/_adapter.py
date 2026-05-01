"""PixelAdapter — wires sys.excepthook, threading.excepthook, and atexit."""

from __future__ import annotations

import atexit
import json
import platform
import sys
import threading
import uuid
from datetime import datetime, timezone
from types import TracebackType
from typing import Any, Optional, Tuple

from ._context import capture_code_context
from ._fingerprint import fingerprint
from ._queue import EventQueue
from ._sink import HttpSink
from ._stack import parse_traceback
from ._types import Level, ReportInput, WireEvent


class PixelAdapter:
    """Wires together the HTTP sink, event queue, and system hooks."""

    def __init__(
        self,
        project_key: str,
        ingest_url: str,
        *,
        capture_console_errors: bool = True,
        runtime: Optional[str] = None,
    ) -> None:
        self._project_key = project_key
        self._runtime = runtime or f"python-{platform.python_version()}"
        self._sink = HttpSink(ingest_url)
        self._queue = EventQueue(self._sink)

        # Save original hooks so we can chain and restore.
        self._old_excepthook: Any = sys.excepthook
        self._old_threading_excepthook: Any = getattr(
            threading, "excepthook", None
        )

        # Install hooks.
        sys.excepthook = self._sys_excepthook
        if hasattr(threading, "excepthook"):
            threading.excepthook = self._threading_excepthook  # type: ignore[attr-defined]

        atexit.register(self._atexit_flush)

        self._closed = False

    # ── public API ────────────────────────────────────────────────────

    def report(self, input: ReportInput) -> None:
        """Manually report an error or message."""
        level: Level = input.level
        if input.error is not None:
            try:
                event = self._build_event(input.error, level, manual=True)
                if input.message:
                    event.message = input.message
                self._queue.enqueue(event)
            except Exception:
                pass
            return
        # No error object — synthesize one from the message.
        err = RuntimeError(input.message)
        err.name = "ManualReport"  # type: ignore[attr-defined]
        try:
            self._enqueue_error(err, level, manual=True)
        except Exception:
            pass

    def flush(self) -> None:
        """Drain the event queue synchronously."""
        self._queue.flush()

    def close(self) -> None:
        """Flush, tear down hooks, and prevent further events."""
        if self._closed:
            return
        self._closed = True

        # Restore original hooks.
        sys.excepthook = self._old_excepthook
        if self._old_threading_excepthook is not None and hasattr(
            threading, "excepthook"
        ):
            threading.excepthook = self._old_threading_excepthook  # type: ignore[attr-defined]

        atexit.unregister(self._atexit_flush)
        self._queue.close()

    # ── hook callbacks ────────────────────────────────────────────────

    def _sys_excepthook(
        self,
        exc_type: type,
        exc_value: BaseException,
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Handle uncaught exceptions in the main thread."""
        self._enqueue_error_sync(exc_value, "fatal", manual=False)
        # Chain to the original hook so the default traceback still prints.
        if self._old_excepthook is not None:
            try:
                self._old_excepthook(exc_type, exc_value, exc_tb)
            except Exception:
                pass

    def _threading_excepthook(self, args: Any) -> None:
        """Handle uncaught exceptions in threads (Python 3.8+)."""
        exc_value = args.exc_value if hasattr(args, "exc_value") else None
        if exc_value is not None:
            self._enqueue_error_sync(exc_value, "fatal", manual=False)
        # Chain to the original hook.
        if self._old_threading_excepthook is not None:
            try:
                self._old_threading_excepthook(args)
            except Exception:
                pass

    def _atexit_flush(self) -> None:
        """Flush pending events on process exit."""
        try:
            self._queue.flush()
        except Exception:
            pass

    # ── internal ──────────────────────────────────────────────────────

    def _enqueue_error(self, err: Any, level: Level, manual: bool) -> None:
        try:
            event = self._build_event(err, level, manual)
            self._queue.enqueue(event)
        except Exception:
            pass

    def _enqueue_error_sync(self, err: Any, level: Level, manual: bool) -> None:
        try:
            event = self._build_event(err, level, manual)
            self._queue.enqueue_sync(event)
        except Exception:
            pass

    def _build_event(
        self, err: Any, level: Level, manual: bool
    ) -> WireEvent:
        """Normalize an error into a WireEvent."""
        error_type, message, tb = self._normalize(err)
        stack = parse_traceback(tb)
        return WireEvent(
            event_id=str(uuid.uuid4()),
            project_key=self._project_key,
            fingerprint=fingerprint(error_type, stack),
            type=error_type,
            message=message,
            stack=stack,
            code_context=capture_code_context(stack),
            runtime=self._runtime,
            manual_report=manual,
            level=level,
            occurred_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )

    @staticmethod
    def _normalize(
        err: Any,
    ) -> Tuple[str, str, Optional[TracebackType]]:
        """Extract (type_name, message, traceback) from an arbitrary error."""
        if isinstance(err, BaseException):
            return (
                type(err).__name__ or "Error",
                str(err),
                err.__traceback__,
            )
        if isinstance(err, str):
            return ("StringError", err, None)
        try:
            return ("UnknownError", json.dumps(err), None)
        except (TypeError, ValueError):
            return ("UnknownError", str(err), None)
