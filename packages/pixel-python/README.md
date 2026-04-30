# ez-pixel

Universal error tracking SDK for Python. Part of the [ezcoder](https://github.com/Gahroot/ezcoder) ecosystem.

## Install

```bash
pip install ez-pixel
```

## Quick Start

### Automatic setup (recommended)

```bash
ezcoder pixel install
```

This detects your Python project, installs `ez-pixel`, wires the init file into your entry point, and generates a project key.

### Manual setup

```python
import ez_pixel

ez_pixel.init_pixel(
    project_key="pk_live_abc123",
    ingest_url="https://your-pixel-server.workers.dev/ingest",
)
```

That's it — unhandled exceptions are now tracked automatically.

## API

### `init_pixel(project_key, ingest_url, *, runtime=None)`

Initialize the SDK. Registers `sys.excepthook`, `threading.excepthook`, and `atexit` handlers.

### `report_pixel(message, error=None, level="error")`

Manually report an error.

```python
try:
    risky_operation()
except Exception as e:
    ez_pixel.report_pixel("Risky operation failed", error=e, level="warning")
```

### `flush_pixel()`

Drain the internal event queue (blocking). Call before process exit in short-lived scripts.

### `close_pixel()`

Flush + tear down all hooks and deactivate the SDK.

## Features

- **Zero dependencies** — uses only the Python standard library
- **Thread-safe** — events are queued and drained in a background thread
- **Exponential backoff** — retries failed deliveries (0.2s → 0.4s → 0.8s → 1.6s → 3.2s)
- **Code context** — captures source lines around the error
- **Fingerprinting** — groups duplicate errors with SHA-256 fingerprints
- **Python 3.8+** — works on older Python versions

## Wire Format

Events are posted as JSON to the ingest endpoint:

```json
{
  "event_id": "uuid4",
  "project_key": "pk_live_abc123",
  "fingerprint": "sha256(type + top frame)[:16]",
  "type": "ValueError",
  "message": "something went wrong",
  "stack": [{"file": "main.py", "line": 42, "col": 0, "fn": "run", "in_app": true}],
  "code_context": {"file": "main.py", "error_line": 42, "lines": ["..."]},
  "runtime": "python-3.12.3",
  "manual_report": false,
  "level": "error",
  "occurred_at": "2026-04-29T14:22:01Z"
}
```

## License

MIT
