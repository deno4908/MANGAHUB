import argparse
import logging
import sys
from .config import Settings


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="API TruyenQQ trực tiếp, không database")
    parser.add_argument("--base-url", help="Tên miền nguồn nếu website đổi tên miền")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="Chạy trang truyện/tài liệu /docs và Swagger /swagger")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    settings = Settings(**({"base_url": args.base_url} if args.base_url else {}))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    import uvicorn
    from .api import create_app
    uvicorn.run(create_app(settings), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
