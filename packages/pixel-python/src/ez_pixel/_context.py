"""Capture source code context around the error line."""

from __future__ import annotations

from typing import Dict, List, Optional

from ._types import CodeContext, StackFrame

_WINDOW = 2
_cache: Dict[str, Optional[List[str]]] = {}


def capture_code_context(
    stack: List[StackFrame],
    window: int = _WINDOW,
) -> Optional[CodeContext]:
    """Read source lines around the top in-app frame's line number.

    Returns ``None`` if no readable frame is found or the file cannot be read.
    """
    top = None
    for frame in stack:
        if _is_readable(frame.file):
            top = frame
            break
    if top is None:
        return None

    lines = _load_lines(top.file)
    if lines is None:
        return None

    start = max(0, top.line - 1 - window)
    end = min(len(lines), top.line + window)
    return CodeContext(
        file=top.file,
        error_line=top.line,
        lines=lines[start:end],
    )


def _is_readable(filename: str) -> bool:
    """Check whether a file is worth reading for code context."""
    if not filename:
        return False
    if filename.startswith("<"):
        return False
    if "/site-packages/" in filename or "/dist-packages/" in filename:
        return False
    return filename.endswith(".py") or filename.endswith(".pyx")


def _load_lines(filename: str) -> Optional[List[str]]:
    """Read a file's lines, with a simple in-process cache."""
    if filename in _cache:
        cached = _cache[filename]
        return cached if cached is not None else None
    try:
        with open(filename, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        _cache[filename] = lines
        return lines
    except OSError:
        _cache[filename] = None
        return None
