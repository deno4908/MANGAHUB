"""
Flask application factory.
"""
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from config import config
from maintenance import get_maintenance_state, is_admin_authorized, maintenance_payload


_limiter_storage_uri = "memory://" if config.FLASK_DEBUG else (config.REDIS_URL or "memory://")

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=_limiter_storage_uri,
    default_limits=[],
)


def create_app() -> Flask:
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

    maintenance_auth_bootstrap_paths = {
        "/auth/login",
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
