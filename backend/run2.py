"""
High-throughput entry point.
Runs Flask and FastAPI concurrently with multi-thread/multi-worker settings.

Usage:
  python run2.py
"""

import multiprocessing
from pathlib import Path
import signal
import uvicorn
from dotenv import load_dotenv

# Always load backend/.env first, even when command is launched from workspace root.
load_dotenv(Path(__file__).resolve().parent / ".env", override=False)

from config import config


def _resolve_fastapi_workers() -> int:
    """Resolve worker count from config or CPU."""
    configured = max(0, int(getattr(config, "FASTAPI_WORKERS", 0) or 0))
    if configured > 0:
        return configured
    # Auto mode: use CPU, bounded to avoid oversubscription on local machines.
    return max(2, min(4, multiprocessing.cpu_count()))


def run_flask_threaded() -> None:
    """Run Flask auth gateway in threaded mode."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    from flask_app import create_app

    app = create_app()
    app.run(
        host="0.0.0.0",
        port=config.FLASK_PORT,
        debug=config.FLASK_DEBUG,
        use_reloader=False,
        threaded=True,
    )


def run_fastapi_multiworker() -> None:
    """Run FastAPI with multiple workers and reload disabled."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    workers = _resolve_fastapi_workers()
    uvicorn.run(
        "fastapi_app.main:app",
        host="0.0.0.0",
        port=config.FASTAPI_PORT,
        reload=False,
        workers=workers,
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()

    fastapi_workers = _resolve_fastapi_workers()

    print("=" * 50)
    print("  Manga-Bliss Backend (run2 multi)")
    print(f"  Flask Gateway  -> http://localhost:{config.FLASK_PORT} (threaded)")
    print(f"  FastAPI Service -> http://localhost:{config.FASTAPI_PORT}")
    print("  FastAPI Reload  -> False")
    print(f"  FastAPI Workers -> {fastapi_workers}")
    print(f"  API Docs       -> http://localhost:{config.FASTAPI_PORT}/docs")
    print("=" * 50)

    flask_process = multiprocessing.Process(
        target=run_flask_threaded,
        name="flask-threaded",
    )
    fastapi_process = multiprocessing.Process(
        target=run_fastapi_multiworker,
        name="fastapi-multiworker",
    )

    flask_process.start()
    fastapi_process.start()

    try:
        while flask_process.is_alive() and fastapi_process.is_alive():
            flask_process.join(timeout=0.2)
            fastapi_process.join(timeout=0.2)
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        for process in (flask_process, fastapi_process):
            if process.is_alive():
                process.terminate()
        for process in (flask_process, fastapi_process):
            process.join(timeout=3)
        for process in (flask_process, fastapi_process):
            if process.is_alive():
                process.kill()
                process.join(timeout=1)
