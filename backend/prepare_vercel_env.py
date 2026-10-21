"""Create a local import file for the Vercel dashboard. Never prints secrets."""
import argparse
import json
import os
import secrets
from pathlib import Path

from dotenv import dotenv_values
from jwcrypto import jwk


def prepare(frontend_url):
    base = Path(__file__).resolve().parent
    target = base / ".env.vercel.local"
    if target.exists():
        raise SystemExit(".env.vercel.local already exists; edit it instead of rotating live secrets.")
    values = {**dotenv_values(base.parent / ".env"), **dotenv_values(base / ".env")}
    key_file = base / ".auth-credential-key.json"
    raw_key = values.get("AUTH_CREDENTIAL_PRIVATE_JWK")
    key = jwk.JWK.from_json(raw_key or key_file.read_text(encoding="utf-8")) if raw_key or key_file.exists() else jwk.JWK.generate(kty="RSA", size=3072)
    if key.get("kty") != "RSA" or not key.has_private:
        raise SystemExit("The authentication encryption key must be a private RSA key.")
    public_modulus = key.export_public(as_dict=True)["n"]
    import base64
    bits = int.from_bytes(base64.urlsafe_b64decode(public_modulus + "=" * (-len(public_modulus) % 4)), "big").bit_length()
    if bits < 3072:
        raise SystemExit("The authentication encryption key must have at least 3072 bits.")
    result = {
        "FRONTEND_URL": frontend_url.rstrip("/"),
        "FLASK_DEBUG": "false", "FASTAPI_RELOAD": "false",
        "ALLOW_DEV_SECRET_FALLBACK": "false", "CORS_ALLOW_LOCALHOST": "false",
        "SECURITY_REQUIRE_REDIS": "true",
        "OCR_ENABLED": "false",
        "REDIS_URL": values.get("REDIS_URL") if str(values.get("REDIS_URL") or "").startswith("rediss://") else "REPLACE_WITH_REDIS_TLS_CONNECTION_URL",
        "SUPABASE_URL": values.get("SUPABASE_URL") or "REPLACE_WITH_SUPABASE_URL",
        "SUPABASE_KEY": values.get("SUPABASE_KEY") or "REPLACE_WITH_SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_KEY": values.get("SUPABASE_SERVICE_KEY") or "REPLACE_WITH_SUPABASE_SERVICE_ROLE_KEY",
        "FLASK_SECRET_KEY": values.get("FLASK_SECRET_KEY") if len(values.get("FLASK_SECRET_KEY") or "") >= 32 else secrets.token_hex(32),
        "JWT_SECRET_KEY": values.get("JWT_SECRET_KEY") if len(values.get("JWT_SECRET_KEY") or "") >= 32 else secrets.token_hex(32),
        "AUTH_CREDENTIAL_PRIVATE_JWK": key.export_private(),
        "CRON_SECRET": secrets.token_hex(32),
    }
    for name in ("RECAPTCHA_SECRET_KEY", "RECAPTCHA_REQUIRED", "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM_EMAIL", "SMTP_USE_SSL", "SMTP_USE_TLS", "OPENROUTER_API_KEY"):
        if values.get(name):
            result[name] = values[name]
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        for name, value in result.items():
            # Single quotes preserve the JWK's JSON double quotes in both
            # Python dotenv and the dashboard's Node dotenv parser.
            encoded = "'" + value + "'" if "'" not in value and "\n" not in value else json.dumps(value, ensure_ascii=False)
            stream.write(name + "=" + encoded + "\n")
    print("Created backend/.env.vercel.local. Replace REPLACE_WITH_ values, then import it into the BACKEND Vercel project. Do not commit or share it.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend-url", default="https://mangahub.art")
    arguments = parser.parse_args()
    if not arguments.frontend_url.startswith("https://"):
        parser.error("--frontend-url must be an HTTPS origin")
    prepare(arguments.frontend_url)
