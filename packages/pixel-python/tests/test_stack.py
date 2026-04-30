"""Tests for the stack parsing module."""

import traceback

from ez_pixel._stack import parse_traceback, _is_in_app
from ez_pixel._types import StackFrame


def _make_tb():
    """Create a real traceback by raising and catching."""
    try:
        def inner():
            raise ValueError("boom")
        inner()
    except ValueError:
        return traceback.extract_tb(
            __import__("sys").exc_info()[2]
        )


class TestParseTraceback:
    def test_none_returns_empty(self):
        assert parse_traceback(None) == []

    def test_list_of_frame_summaries(self):
        summaries = _make_tb()
        frames = parse_traceback(summaries)
        assert len(frames) > 0
        for f in frames:
            assert isinstance(f, StackFrame)
            assert f.col == 0  # Python tracebacks don't have column info
            assert isinstance(f.in_app, bool)

    def test_real_traceback_object(self):
        try:
            raise TypeError("test error")
        except TypeError:
            import sys
            tb = sys.exc_info()[2]
        frames = parse_traceback(tb)
        assert len(frames) > 0
        assert frames[0].fn == "test_real_traceback_object"
        assert frames[0].in_app is True

    def test_col_always_zero(self):
        summaries = _make_tb()
        frames = parse_traceback(summaries)
        for f in frames:
            assert f.col == 0


class TestIsInApp:
    def test_empty_string(self):
        assert _is_in_app("") is False

    def test_frozen_module(self):
        assert _is_in_app("<frozen importlib._bootstrap>") is False

    def test_string_input(self):
        assert _is_in_app("<string>") is False

    def test_site_packages(self):
        assert _is_in_app("/usr/lib/python3/site-packages/requests/api.py") is False

    def test_dist_packages(self):
        assert _is_in_app("/usr/lib/python3/dist-packages/foo.py") is False

    def test_user_code(self):
        assert _is_in_app("/home/user/project/main.py") is True

    def test_pyc_file(self):
        assert _is_in_app("/home/user/project/__pycache__/mod.cpython-312.pyc") is False
