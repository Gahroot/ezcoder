"""Integration tests for init_pixel / report_pixel / flush_pixel / close_pixel."""

import json
import sys
from unittest.mock import MagicMock, patch

from ez_pixel import init_pixel, report_pixel, flush_pixel, close_pixel
from ez_pixel._types import WireEvent


class TestInitPixel:
    def setup_method(self):
        # Ensure a clean slate before each test.
        close_pixel()

    def teardown_method(self):
        close_pixel()

    @patch("ez_pixel._adapter.HttpSink")
    def test_init_registers_adapter(self, MockSink):
        adapter = init_pixel("pk_test", "http://localhost:8787/ingest")
        assert adapter is not None
        assert not adapter._closed

    @patch("ez_pixel._adapter.HttpSink")
    def test_double_init_raises(self, MockSink):
        init_pixel("pk_test", "http://localhost:8787/ingest")
        try:
            import pytest
            with pytest.raises(RuntimeError, match="already initialized"):
                init_pixel("pk_other", "http://localhost:8787/ingest")
        except ImportError:
            # pytest not available — just check manually.
            try:
                init_pixel("pk_other", "http://localhost:8787/ingest")
                assert False, "Expected RuntimeError"
            except RuntimeError:
                pass

    @patch("ez_pixel._adapter.HttpSink")
    def test_report_without_init_is_noop(self, MockSink):
        # Should not raise.
        report_pixel("something went wrong")

    @patch("ez_pixel._adapter.HttpSink")
    def test_report_enqueues_event(self, MockSink):
        mock_sink = MockSink.return_value
        init_pixel("pk_test", "http://localhost:8787/ingest")
        report_pixel("test error", level="warning")
        flush_pixel()
        # The sink's emit method should have been called.
        assert mock_sink.emit.call_count >= 1

    @patch("ez_pixel._adapter.HttpSink")
    def test_report_with_error_object(self, MockSink):
        mock_sink = MockSink.return_value
        init_pixel("pk_test", "http://localhost:8787/ingest")
        report_pixel("custom msg", error=ValueError("oops"), level="error")
        flush_pixel()
        assert mock_sink.emit.call_count >= 1

    @patch("ez_pixel._adapter.HttpSink")
    def test_close_teardown(self, MockSink):
        init_pixel("pk_test", "http://localhost:8787/ingest")
        close_pixel()
        # Second close is a no-op.
        close_pixel()

    @patch("ez_pixel._adapter.HttpSink")
    def test_excepthook_chains_to_original(self, MockSink):
        original = sys.excepthook
        init_pixel("pk_test", "http://localhost:8787/ingest")
        # Our hook should be installed.
        assert sys.excepthook is not original
        close_pixel()
        # After close, original hook should be restored.
        assert sys.excepthook is original

    @patch("ez_pixel._adapter.HttpSink")
    def test_wire_event_shape(self, MockSink):
        """Verify the wire event has all required fields."""
        mock_sink = MockSink.return_value
        init_pixel("pk_test", "http://localhost:8787/ingest")

        try:
            raise ValueError("test boom")
        except ValueError as e:
            report_pixel("test", error=e)

        flush_pixel()

        # Inspect the event that was sent.
        call_args = mock_sink.emit.call_args
        assert call_args is not None
        event = call_args[0][0]
        assert isinstance(event, WireEvent)
        assert event.project_key == "pk_test"
        assert event.type == "ValueError"
        assert event.message == "test"  # overridden by report_pixel's message arg
        assert event.level == "error"
        assert event.manual_report is True
        assert len(event.event_id) > 0
        assert len(event.fingerprint) == 16
        assert event.occurred_at.endswith("Z")
        assert event.runtime.startswith("python-")
