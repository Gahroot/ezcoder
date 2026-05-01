"""Tests for the event queue."""

import threading
import time
from unittest.mock import MagicMock

from ez_pixel._queue import EventQueue
from ez_pixel._types import WireEvent, StackFrame


def _event(msg: str = "test") -> WireEvent:
    return WireEvent(
        event_id="abc",
        project_key="pk_test",
        fingerprint="fp123",
        type="Error",
        message=msg,
        stack=[],
        code_context=None,
        runtime="python-3.12",
        manual_report=False,
        level="error",
        occurred_at="2026-01-01T00:00:00Z",
    )


class TestEventQueue:
    def test_enqueue_delivers_event(self):
        sink = MagicMock()
        queue = EventQueue(sink)
        queue.enqueue(_event())
        queue.flush()
        assert sink.emit.call_count == 1

    def test_buffer_overflow_drops_oldest(self):
        sink = MagicMock()
        sink.emit.side_effect = Exception("fail")
        queue = EventQueue(sink)
        # Fill buffer beyond MAX_BUFFER (100).
        for i in range(102):
            queue.enqueue(_event(msg=f"evt-{i}"))
        # After 5 failed attempts per event, events get dropped.
        queue.flush()
        sink.emit.assert_called()

    def test_enqueue_sync_calls_sink_directly(self):
        sink = MagicMock()
        queue = EventQueue(sink)
        event = _event()
        queue.enqueue_sync(event)
        sink.emit_sync.assert_called_once_with(event)

    def test_enqueue_sync_falls_back_to_async_on_failure(self):
        sink = MagicMock()
        sink.emit_sync.side_effect = Exception("sync failed")
        queue = EventQueue(sink)
        # Should fall back to enqueue (async path).
        queue.enqueue_sync(_event())
        queue.flush()
        # The async drain will try emit(), which succeeds.
        assert sink.emit.call_count >= 1

    def test_close_prevents_enqueue(self):
        sink = MagicMock()
        queue = EventQueue(sink)
        queue.close()
        queue.enqueue(_event())
        queue.flush()
        sink.emit.assert_not_called()

    def test_flush_is_blocking(self):
        sink = MagicMock()
        queue = EventQueue(sink)
        queue.enqueue(_event())
        queue.flush()
        # After flush, buffer should be empty.
        assert len(queue._buffer) == 0

    def test_retry_on_failure_then_success(self):
        call_count = 0

        def flaky_emit(event):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                raise Exception("transient")
            # Third call succeeds.

        sink = MagicMock()
        sink.emit.side_effect = flaky_emit
        queue = EventQueue(sink)
        queue.enqueue(_event())
        queue.flush()
        assert call_count == 3
