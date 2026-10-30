"""
Flask application factory.
"""
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from redis.exceptions import RedisError, ResponseError
from config import config
from maintenance import get_maintenance_state, is_admin_authorized, maintenance_payload
from proxy_trust import resolve_client_ip
from security_runtime import ensure_security_redis_available


_limiter_storage_uri = "memory://" if config.FLASK_DEBUG else (config.REDIS_URL or "memory://")


def _limiter_client_ip() -> str:
    return resolve_client_ip(request.remote_addr, request.headers)


limiter = Limiter(
    key_func=_limiter_client_ip,
    storage_uri=_limiter_storage_uri,
    default_limits=[],
    in_memory_fallback_enabled=not config.SECURITY_REQUIRE_REDIS,
    swallow_errors=False,
)


def create_app() -> Flask:
    ensure_security_redis_available()
    app = Flask(__name__)
    app.secret_key = config.FLASK_SECRET_KEY
    limiter.init_app(app)

    cors_origins = [config.FRONTEND_URL]
    if getattr(config, "CORS_ALLOW_LOCALHOST", False):
        cors_origins.extend([
            "http://localhost:5173",
            "http://localhost:8080",
            "http://localhost:3000",
        ])
    cors_origins = list(dict.fromkeys(origin for origin in cors_origins if origin))

    # CORS — allow configured frontend origins
    CORS(app, origins=cors_origins, supports_credentials=True)

    @app.errorhandler(RedisError)
    def security_store_unavailable(error):
        # Flask-Limiter runs before the auth view. Keep rejecting the request
        # when its shared security store fails; do not bypass rate limits or
        # expose Redis messages, connection URLs, or credentials.
        quota_exceeded = isinstance(error, ResponseError) and "max requests limit exceeded" in str(error).lower()
        code = "AUTH_REDIS_QUOTA_EXCEEDED" if quota_exceeded else "AUTH_SECURITY_STORE_UNAVAILABLE"
        app.logger.error("Authentication security store unavailable code=%s", code)
        response = jsonify({
            "error": "Dịch vụ xác thực tạm thời không khả dụng. Vui lòng thử lại sau.",
            "code": code,
        })
        response.status_code = 503
        response.headers["Cache-Control"] = "no-store, max-age=0"
        if not quota_exceeded:
            response.headers["Retry-After"] = "30"
        return response

    maintenance_auth_bootstrap_paths = {
        "/auth/login",
        "/auth/credential-challenge",
        "/auth/logout",
        "/auth/refresh",
        "/auth/google",
        "/auth/discord",
        "/auth/oauth/callback",
        "/auth/oauth/code",
    }

    @app.before_request
    def enforce_maintenance_mode():
        if request.method == "OPTIONS":
            return None
        if request.path == "/health":
            return None
        state = get_maintenance_state()
        if not state.get("enabled"):
            return None
        if is_admin_authorized(request.headers.get("Authorization")):
            return None
        if request.path in maintenance_auth_bootstrap_paths:
            return None
        response = jsonify(maintenance_payload(state))
        response.status_code = 503
        response.headers["Retry-After"] = "60"
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    @app.after_request
    def prevent_auth_response_cache(response):
        if request.path.startswith("/auth/"):
            payload = response.get_json(silent=True) if response.is_json else None
            is_retry_response = bool(isinstance(payload, dict) and payload.get("requires_retry"))
            if response.status_code >= 500 and not is_retry_response:
                app.logger.error(
                    "Suppressed auth error path=%s status=%s payload=%r",
                    request.path,
                    response.status_code,
                    payload,
                )
                safe_payload = {"error": "Dịch vụ xác thực tạm thời không khả dụng. Vui lòng thử lại sau."}
                if isinstance(payload, dict) and payload.get("code") in {
                    "AUTH_REDIS_QUOTA_EXCEEDED", "AUTH_SECURITY_STORE_UNAVAILABLE",
                    "AUTH_PROVIDER_CONFIG_MISSING", "AUTH_OAUTH_CLIENT_UNAVAILABLE",
                    "AUTH_OAUTH_LINK_UNAVAILABLE", "AUTH_OAUTH_VERIFIER_UNAVAILABLE",
                    "AUTH_OAUTH_RESPONSE_UNAVAILABLE",
                }:
                    safe_payload["code"] = payload["code"]
                    if payload.get("category") in {"SupabaseException", "ValueError", "TypeError", "OSError",
                                                  "AuthApiError", "AuthRetryableError"}:
                        safe_payload["category"] = payload["category"]
                response.set_data(app.json.dumps(safe_payload))
                response.content_type = "application/json"
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    # Register auth blueprint
    from flask_app.auth.routes import auth_bp
    app.register_blueprint(auth_bp, url_prefix="/auth")

    # Health check
    @app.route("/health")
    def health():
        return {"status": "ok", "service": "flask-gateway"}

    return app
