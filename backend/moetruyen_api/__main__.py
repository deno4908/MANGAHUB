import argparse
import sys
import uvicorn


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="API trực tiếp cho truyen.moe")
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    uvicorn.run("moetruyen_api.api:create_app", factory=True, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
