"""
Entry point — runs Flask (auth gateway) and FastAPI (API service) together.
Usage: python run.py
"""
import multiprocessing
import signal
import uvicorn
from config import config


def _resolve_fastapi_workers() -> int:
    """Resolve FastAPI worker count from env or CPU cores."""
    configured = max(0, int(getattr(config, "FASTAPI_WORKERS", 0) or 0))
    if configured > 0:
        return configured
    # Keep a practical default for local/dev and small servers.
    return min(4, max(1, multiprocessing.cpu_count()))


def run_flask():
    """Run Flask auth gateway."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    from flask_app import create_app
    app = create_app()
    app.run(
        host=config.BACKEND_BIND_HOST,
        port=config.FLASK_PORT,
        debug=config.FLASK_DEBUG,
        use_reloader=False  # Avoid double-start in multiprocessing
    )


def run_fastapi():
    """Run FastAPI service."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    reload_enabled = bool(getattr(config, "FASTAPI_RELOAD", config.FLASK_DEBUG))
    workers = 1 if reload_enabled else _resolve_fastapi_workers()
    uvicorn.run(
        "fastapi_app.main:app",
        host=config.BACKEND_BIND_HOST,
        port=config.FASTAPI_PORT,
        reload=reload_enabled,
        workers=workers,
        proxy_headers=False,
    )


if __name__ == "__main__":
    resolved_reload = bool(getattr(config, "FASTAPI_RELOAD", config.FLASK_DEBUG))
    resolved_fastapi_workers = 1 if resolved_reload else _resolve_fastapi_workers()
    print("=" * 50)
    print("  Manga-Bliss Backend")
    print(f"  Flask Gateway  -> http://localhost:{config.FLASK_PORT}")
    print(f"  FastAPI Service -> http://localhost:{config.FASTAPI_PORT}")
    print(f"  FastAPI Reload  -> {resolved_reload}")
    print(f"  FastAPI Workers -> {resolved_fastapi_workers}")
    print(f"  API Docs       -> http://localhost:{config.FASTAPI_PORT}/docs")
    print("=" * 50)

    flask_process = multiprocessing.Process(target=run_flask)
    fastapi_process = multiprocessing.Process(target=run_fastapi)

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
