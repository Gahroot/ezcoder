"""ez-pixel — Universal error tracking SDK for Python.

Public API
----------
init_pixel(project_key, ingest_url, ...)
    Register global error handlers and start tracking.
report_pixel(message, error=None, level="error")
    Manually report an error or message.
flush_pixel()
    Drain the internal event queue (blocking).
close_pixel()
    Flush + tear down all hooks.
"""

from __future__ import annotations

from typing import Optional

from ._adapter import PixelAdapter
from ._types import CodeContext, Level, ReportInput, StackFrame, WireEvent

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "init_pixel",
    "report_pixel",
    "flush_pixel",
    "close_pixel",
    "Level",
    "ReportInput",
    "StackFrame",
    "CodeContext",
    "WireEvent",
]

_adapter: Optional[PixelAdapter] = None


def init_pixel(
    project_key: str,
    ingest_url: str,
    *,
    capture_console_errors: bool = True,
    runtime: Optional[str] = None,
) -> PixelAdapter:
    """Initialize the pixel SDK — registers ``sys.excepthook``,
    ``threading.excepthook``, and ``atexit`` handlers.

    Parameters
    ----------
    project_key:
        The project key (``pk_live_...``) obtained from ``ezcoder pixel install``.
    ingest_url:
        Full URL of the ingest endpoint (e.g. ``https://...workers.dev/ingest``).
    capture_console_errors:
        *(reserved — not yet wired in Python)*
    runtime:
        Override the runtime string (default ``"python-<version>"``).

    Returns
    -------
    PixelAdapter
        The active adapter instance.

    Raises
    ------
    RuntimeError
        If ``init_pixel`` is called while a previous adapter is still active.
    """
    global _adapter
    if _adapter is not None:
        raise RuntimeError(
            "ez-pixel is already initialized; call close_pixel() first"
        )
    _adapter = PixelAdapter(
        project_key,
        ingest_url,
        capture_console_errors=capture_console_errors,
        runtime=runtime,
    )
    return _adapter


def report_pixel(
    message: str,
    error: Optional[BaseException] = None,
    level: Level = "error",
) -> None:
    """Manually report an error or message.

    Parameters
    ----------
    message:
        Human-readable description of the error.
    error:
        Optional exception instance.  If omitted a synthetic ``RuntimeError``
        is created from *message*.
    level:
        Severity — ``"error"`` (default), ``"warning"``, or ``"fatal"``.
    """
    if _adapter is None:
        return
    _adapter.report(ReportInput(message=message, error=error, level=level))


def flush_pixel() -> None:
    """Drain the internal event queue (blocking).

    Call this before process exit in short-lived scripts to ensure all
    pending events have been sent.
    """
    if _adapter is None:
        return
    _adapter.flush()


def close_pixel() -> None:
    """Flush the queue, tear down all hooks, and deactivate the SDK."""
    global _adapter
    if _adapter is None:
        return
    _adapter.close()
    _adapter = None
