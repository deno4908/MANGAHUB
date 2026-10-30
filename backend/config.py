"""
Configuration module - loads environment variables and provides config objects.
"""
import os
from pathlib import Path
from dotenv import load_dotenv
from serverless_runtime import IS_VERCEL

_BASE_DIR = Path(__file__).resolve().parent
_PROJECT_DIR = _BASE_DIR.parent
if not IS_VERCEL:
    load_dotenv(_PROJECT_DIR / ".env")
    load_dotenv(_BASE_DIR / ".env", override=True)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    """Base configuration."""

    IS_VERCEL: bool = IS_VERCEL
    OCR_ENABLED: bool = _env_bool("OCR_ENABLED", False)

    # Supabase
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY: str = os.getenv("SUPABASE_KEY", "")
    SUPABASE_SERVICE_KEY: str = os.getenv("SUPABASE_SERVICE_KEY", "")

    # Flask
    FLASK_SECRET_KEY: str = os.getenv("FLASK_SECRET_KEY", "")
    BACKEND_BIND_HOST: str = os.getenv("BACKEND_BIND_HOST", "127.0.0.1")
    FLASK_PORT: int = int(os.getenv("FLASK_PORT", "5000"))
    FLASK_DEBUG: bool = _env_bool("FLASK_DEBUG", False)
    ALLOW_DEV_SECRET_FALLBACK: bool = _env_bool("ALLOW_DEV_SECRET_FALLBACK", FLASK_DEBUG)

    # FastAPI
    FASTAPI_PORT: int = int(os.getenv("FASTAPI_PORT", "8000"))
    FASTAPI_RELOAD: bool = _env_bool("FASTAPI_RELOAD", FLASK_DEBUG)
    # 0 = auto (resolved in run.py)
    FASTAPI_WORKERS: int = int(os.getenv("FASTAPI_WORKERS", "0"))

    # Redis
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    REDIS_FALLBACK_URL: str = os.getenv("REDIS_FALLBACK_URL", "")
    REDIS_SECURITY_URL: str = os.getenv("REDIS_SECURITY_URL", "")
    REDIS_CONNECT_TIMEOUT_SECONDS: float = max(0.05, min(2.0, float(os.getenv("REDIS_CONNECT_TIMEOUT_SECONDS", "0.35"))))
    REDIS_SOCKET_TIMEOUT_SECONDS: float = max(0.05, min(2.0, float(os.getenv("REDIS_SOCKET_TIMEOUT_SECONDS", "0.5"))))
    REDIS_RECOVERY_CHECK_SECONDS: int = max(30, int(os.getenv("REDIS_RECOVERY_CHECK_SECONDS", "60")))

    # CORS
    FRONTEND_URL: str = os.getenv(
        "FRONTEND_URL",
        "http://localhost:8080" if FLASK_DEBUG else "",
    )
    CORS_ALLOW_LOCALHOST: bool = _env_bool("CORS_ALLOW_LOCALHOST", FLASK_DEBUG)

    # Reverse proxy / distributed rate-limit security. HTTPS deployments fail
    # closed when Redis is unavailable; local HTTP development keeps its fallback.
    TRUSTED_PROXY_CIDRS: str = os.getenv(
        "TRUSTED_PROXY_CIDRS",
        "127.0.0.1/32,::1/128",
    )
    SECURITY_REQUIRE_REDIS: bool = _env_bool(
        "SECURITY_REQUIRE_REDIS",
        FRONTEND_URL.lower().startswith("https://"),
    )

    # Auth
    EMAIL_VERIFY_TIMEOUT_MINUTES: int = int(os.getenv("EMAIL_VERIFY_TIMEOUT_MINUTES", "15"))
    REFRESH_COOKIE_MAX_AGE_SECONDS: int = int(
        os.getenv("REFRESH_COOKIE_MAX_AGE_SECONDS", str(60 * 60 * 24 * 30))
    )
    REFRESH_ROTATION_GRACE_SECONDS: int = int(
        os.getenv("REFRESH_ROTATION_GRACE_SECONDS", "30")
    )

    # Google reCAPTCHA v2
    RECAPTCHA_SECRET_KEY: str = os.getenv("RECAPTCHA_SECRET_KEY", "")
    RECAPTCHA_REQUIRED: bool = _env_bool("RECAPTCHA_REQUIRED", bool(RECAPTCHA_SECRET_KEY))
    RECAPTCHA_VERIFY_URL: str = os.getenv(
        "RECAPTCHA_VERIFY_URL",
        "https://www.google.com/recaptcha/api/siteverify",
    )
    RECAPTCHA_TIMEOUT_SECONDS: int = int(os.getenv("RECAPTCHA_TIMEOUT_SECONDS", "5"))

    # Support email / SMTP
    SUPPORT_EMAIL: str = os.getenv("SUPPORT_EMAIL", "cskh.mangahub@gmail.com")
    SMTP_HOST: str = os.getenv("SMTP_HOST") or os.getenv("MAIL_SERVER") or os.getenv("EMAIL_HOST", "")
    SMTP_PORT: int = int(os.getenv("SMTP_PORT") or os.getenv("MAIL_PORT") or os.getenv("EMAIL_PORT", "587"))
    SMTP_USERNAME: str = (
        os.getenv("SMTP_USERNAME")
        or os.getenv("MAIL_USERNAME")
        or os.getenv("EMAIL_HOST_USER")
        or ""
    )
    SMTP_PASSWORD: str = (
        os.getenv("SMTP_PASSWORD")
        or os.getenv("MAIL_PASSWORD")
        or os.getenv("EMAIL_HOST_PASSWORD")
        or ""
    )
    SMTP_FROM_EMAIL: str = (
        os.getenv("SMTP_FROM_EMAIL")
        or os.getenv("MAIL_DEFAULT_SENDER")
        or os.getenv("EMAIL_FROM")
        or SMTP_USERNAME
    )
    SMTP_USE_SSL: bool = _env_bool("SMTP_USE_SSL", _env_bool("MAIL_USE_SSL", False))
    SMTP_USE_TLS: bool = _env_bool("SMTP_USE_TLS", _env_bool("MAIL_USE_TLS", not SMTP_USE_SSL))
    SMTP_TIMEOUT_SECONDS: int = int(os.getenv("SMTP_TIMEOUT_SECONDS", "15"))

    # JWT
    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "")
    JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", "HS256")
    JWT_EXPIRATION_HOURS: int = int(os.getenv("JWT_EXPIRATION_HOURS", "24"))

    # OpenRouter (AI Translation)
    OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")


config = Config()

if not config.FLASK_SECRET_KEY:
    if config.ALLOW_DEV_SECRET_FALLBACK:
        config.FLASK_SECRET_KEY = "dev-secret-key"
    else:
        raise ValueError("FLASK_SECRET_KEY is required")

if not config.JWT_SECRET_KEY:
    if config.ALLOW_DEV_SECRET_FALLBACK:
        config.JWT_SECRET_KEY = "dev-jwt-secret"
    else:
        raise ValueError("JWT_SECRET_KEY is required")

if not config.FRONTEND_URL and not config.FLASK_DEBUG:
    raise ValueError("FRONTEND_URL is required")
