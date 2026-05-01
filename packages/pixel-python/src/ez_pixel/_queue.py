"""Thread-safe retry queue with exponential backoff and background drain."""

from __future__ import annotations

import threading
import time
import traceback
from collections import deque
from typing import Optional

from ._sink import HttpSink
from ._types import WireEvent

_MAX_BUFFER = 100
_BASE_DELAY_S = 0.2
_MAX_DELAY_S = 5.0
_MAX_ATTEMPTS = 5


class EventQueue:
    """In-memory queue that drains events to an HttpSink in a background thread.

    * Thread-safe: guarded by ``threading.Lock``.
    * Exponential backoff on failure: 0.2 s → 0.4 s → 0.8 s → 1.6 s → 3.2 s.
    * Drops events after 5 consecutive failures (logs a warning).
    * Flushes synchronously on ``flush()`` / ``close()``.
    """

    def __init__(self, sink: HttpSink) -> None:
        self._sink = sink
        self._buffer: deque[WireEvent] = deque()
        self._lock = threading.Lock()
        self._draining = False
        self._closed = False
        self._drain_event = threading.Event()
        self._drain_thread: Optional[threading.Thread] = None

    def enqueue(self, event: WireEvent) -> None:
        """Add an event and kick off the background drain."""
        with self._lock:
            if self._closed:
                return
            if len(self._buffer) >= _MAX_BUFFER:
                self._buffer.popleft()
            self._buffer.append(event)
        self._ensure_drain_thread()

    def enqueue_sync(self, event: WireEvent) -> None:
        """Blocking emit for fatal errors — bypasses the queue."""
        with self._lock:
            if self._closed:
                return
        try:
            self._sink.emit_sync(event)
        except Exception:
            # Fall back to the async path so the retry logic can retry.
            self.enqueue(event)

    def flush(self) -> None:
        """Block until every queued event has been delivered or dropped."""
        # If a background drain is running, spin-wait until the buffer is empty.
        # Otherwise, drain synchronously on the calling thread.
        waited = 0
        while True:
            with self._lock:
                if not self._buffer and not self._draining:
                    return
                if not self._draining:
                    break  # no one is draining, we'll do it below
            time.sleep(0.01)
            waited += 1
            if waited > 500:  # 5 seconds timeout
                return
        self._drain_loop()

    def close(self) -> None:
        """Flush, then mark the queue as closed."""
        self.flush()
        with self._lock:
            self._closed = True

    # ── internal ──────────────────────────────────────────────────────

    def _ensure_drain_thread(self) -> None:
        """Start a background drain thread if one isn't already running."""
        should_start = False
        with self._lock:
            if self._drain_thread is not None and self._drain_thread.is_alive():
                return
            if self._closed:
                return
            should_start = True
        if should_start:
            t = threading.Thread(target=self._background_drain, daemon=True)
            with self._lock:
                self._drain_thread = t
            t.start()

    def _background_drain(self) -> None:
        self._drain_loop()

    def _drain_loop(self) -> None:
        """Process events from the buffer with exponential backoff."""
        with self._lock:
            if self._draining:
                return
            self._draining = True

        attempt = 0
        try:
            while True:
                with self._lock:
                    if not self._buffer:
                        break
                    event = self._buffer[0]

                try:
                    self._sink.emit(event)
                    with self._lock:
                        if self._buffer and self._buffer[0] is event:
                            self._buffer.popleft()
                    attempt = 0
                except Exception as exc:
                    attempt += 1
                    if attempt >= _MAX_ATTEMPTS:
                        import sys

                        print(
                            f"[ez-pixel] dropping event after {_MAX_ATTEMPTS} "
                            f"failed deliveries: {exc}",
                            file=sys.stderr,
                        )
                        with self._lock:
                            if self._buffer and self._buffer[0] is event:
                                self._buffer.popleft()
                        attempt = 0
                        continue

                    delay = min(_BASE_DELAY_S * 2 ** (attempt - 1), _MAX_DELAY_S)
                    time.sleep(delay)
        finally:
            with self._lock:
                self._draining = False
