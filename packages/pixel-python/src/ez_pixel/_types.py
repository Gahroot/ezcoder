"""Core types for the ez-pixel SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Literal, Optional

Level = Literal["error", "warning", "fatal"]


@dataclass
class StackFrame:
    """A single frame in a stack trace."""

    file: str
    line: int
    col: int
    fn: str
    in_app: bool


@dataclass
class CodeContext:
    """Source code lines surrounding the error line."""

    file: str
    error_line: int
    lines: List[str] = field(default_factory=list)


@dataclass
class WireEvent:
    """The wire-format event payload posted to the ingest endpoint."""

    event_id: str
    project_key: str
    fingerprint: str
    type: str
    message: str
    stack: List[StackFrame] = field(default_factory=list)
    code_context: Optional[CodeContext] = None
    runtime: str = ""
    manual_report: bool = False
    level: Level = "error"
    occurred_at: str = ""


@dataclass
class ReportInput:
    """Input for manual error reporting via report_pixel()."""

    message: str
    error: Optional[BaseException] = None
    level: Level = "error"
