"""Tests for the fingerprint module."""

import hashlib

from ez_pixel._fingerprint import fingerprint, _normalize_file
from ez_pixel._types import StackFrame


def _frame(file: str, fn: str = "my_func", line: int = 10) -> StackFrame:
    return StackFrame(file=file, line=line, col=0, fn=fn, in_app=True)


class TestFingerprint:
    def test_basic_fingerprint(self):
        stack = [_frame("/app/main.py", "run", 42)]
        fp = fingerprint("TypeError", stack)
        expected_input = "TypeError|/app/main.py|run|42"
        expected = hashlib.sha256(expected_input.encode()).hexdigest()[:16]
        assert fp == expected

    def test_empty_stack(self):
        fp = fingerprint("ValueError", [])
        expected_input = "ValueError|<no-stack>"
        expected = hashlib.sha256(expected_input.encode()).hexdigest()[:16]
        assert fp == expected

    def test_uses_top_frame(self):
        top = _frame("/app/a.py", "first", 1)
        second = _frame("/app/b.py", "second", 2)
        fp1 = fingerprint("Error", [top, second])
        fp2 = fingerprint("Error", [top])
        assert fp1 == fp2

    def test_anon_function_name(self):
        stack = [StackFrame(file="/app/x.py", line=5, col=0, fn="", in_app=True)]
        fp = fingerprint("Error", stack)
        expected_input = "Error|/app/x.py|<anon>|5"
        expected = hashlib.sha256(expected_input.encode()).hexdigest()[:16]
        assert fp == expected

    def test_stable_across_calls(self):
        stack = [_frame("/app/main.py", "run", 42)]
        assert fingerprint("Error", stack) == fingerprint("Error", stack)


class TestNormalizeFile:
    def test_strips_file_prefix(self):
        assert _normalize_file("file:///app/main.py") == "/app/main.py"

    def test_strips_site_packages(self):
        result = _normalize_file("/usr/lib/python3.12/site-packages/requests/api.py")
        assert result == "requests/api.py"

    def test_strips_dist_packages(self):
        result = _normalize_file("/usr/lib/python3/dist-packages/foo/bar.py")
        assert result == "foo/bar.py"

    def test_strips_query_string(self):
        assert _normalize_file("/app/main.py?v=1") == "/app/main.py"

    def test_no_change_for_plain_path(self):
        assert _normalize_file("/app/main.py") == "/app/main.py"
