"""Parse Python tracebacks into StackFrame lists."""

from __future__ import annotations

import traceback
from types import TracebackType
from typing import List, Optional, Union

from ._types import StackFrame


def parse_traceback(
    tb: Optional[Union[TracebackType, List[traceback.FrameSummary]]],
) -> List[StackFrame]:
    """Convert a traceback object or pre-extracted summary into StackFrame[].

    Accepts:
    - A raw ``traceback`` object from ``sys.exc_info()[2]``
    - A list of ``traceback.FrameSummary`` (e.g. from ``traceback.extract_tb()``)
    - ``None`` → empty list
    """
    if tb is None:
        return []

    if isinstance(tb, list):
        summaries = tb
    else:
        summaries = traceback.extract_tb(tb)

    frames: List[StackFrame] = []
    for fs in summaries:
        frames.append(
            StackFrame(
                file=fs.filename,
                line=fs.lineno,
                col=0,
                fn=fs.name,
                in_app=_is_in_app(fs.filename),
            )
        )
    return frames


def _is_in_app(filename: str) -> bool:
    """Determine whether a file belongs to user code (not stdlib/packages).

    Mirrors the TS SDK's ``isInApp()`` logic for Python conventions.
    """
    if not filename:
        return False
    if filename.startswith("<"):
        # <frozen ...>, <string>, <module>, etc.
        return False
    if filename.startswith("node:"):
        return False
    if "/site-packages/" in filename or "/dist-packages/" in filename:
        return False
    if filename.endswith(".pyc"):
        return False
    return True
