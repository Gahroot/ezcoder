"""SHA-256 fingerprint matching the TypeScript SDK's algorithm."""

from __future__ import annotations

import hashlib
from typing import List

from ._types import StackFrame


def fingerprint(error_type: str, stack: List[StackFrame]) -> str:
    """Return a 16-hex-char SHA-256 fingerprint for an error.

    The fingerprint is derived from the error type and the top stack frame,
    matching the algorithm used by the TypeScript ``@prestyj/pixel`` SDK so that
    the same logical error produces the same fingerprint across runtimes.
    """
    top = stack[0] if stack else None
    if top:
        normalized = (
            f"{error_type}|{_normalize_file(top.file)}|{top.fn or '<anon>'}|{top.line}"
        )
    else:
        normalized = f"{error_type}|<no-stack>"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def _normalize_file(file: str) -> str:
    """Normalize a file path so fingerprints are stable across environments.

    Mirrors the TS SDK normalization:
    - Strip ``file://`` prefix
    - Strip everything before ``site-packages/`` or ``dist-packages/``
    - Strip query strings
    """
    import re

    s = re.sub(r"^file://", "", file)
    s = re.sub(r"^.*(site-packages|dist-packages)/", "", s)
    s = re.sub(r"\?.*$", "", s)
    return s
