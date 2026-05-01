"""Tests for the code context capture module."""

import os
import tempfile

from ez_pixel._context import capture_code_context, _cache
from ez_pixel._types import StackFrame


def _write_temp_py(content: str) -> str:
    """Write a temp .py file and return its path."""
    fd, path = tempfile.mkstemp(suffix=".py")
    with os.fdopen(fd, "w") as f:
        f.write(content)
    return path


class TestCaptureCodeContext:
    def setup_method(self):
        _cache.clear()

    def test_returns_context_with_surrounding_lines(self):
        lines = ["line1\n", "line2\n", "line3\n", "line4\n", "line5\n"]
        path = _write_temp_py("".join(lines))
        try:
            stack = [StackFrame(file=path, line=3, col=0, fn="test", in_app=True)]
            ctx = capture_code_context(stack)
            assert ctx is not None
            assert ctx.file == path
            assert ctx.error_line == 3
            # Window=2: splitlines() gives 5 items for 5 newline-terminated lines.
            # start=max(0, 3-1-2)=0, end=min(5, 3+2)=5 → lines[0:5]
            assert len(ctx.lines) == 5
        finally:
            os.unlink(path)

    def test_returns_none_for_empty_stack(self):
        assert capture_code_context([]) is None

    def test_returns_none_for_unreadable_file(self):
        stack = [StackFrame(file="<string>", line=1, col=0, fn="t", in_app=True)]
        assert capture_code_context(stack) is None

    def test_returns_none_for_site_packages(self):
        stack = [
            StackFrame(
                file="/usr/lib/python3/site-packages/foo.py",
                line=10,
                col=0,
                fn="bar",
                in_app=False,
            )
        ]
        assert capture_code_context(stack) is None

    def test_skips_non_py_files(self):
        stack = [StackFrame(file="/tmp/readme.txt", line=1, col=0, fn="t", in_app=True)]
        assert capture_code_context(stack) is None

    def test_caches_file_reads(self):
        path = _write_temp_py("hello\n")
        try:
            stack = [StackFrame(file=path, line=1, col=0, fn="t", in_app=True)]
            capture_code_context(stack)
            assert path in _cache
            # Second call should use cache.
            capture_code_context(stack)
            assert _cache[path] is not None
        finally:
            os.unlink(path)
