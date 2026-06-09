"""
Email delivery helpers for support notifications.
"""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import Any

from config import config

logger = logging.getLogger(__name__)


def _smtp_configured() -> bool:
    return bool(
        config.SMTP_HOST
        and config.SMTP_PORT
        and config.SMTP_USERNAME
        and config.SMTP_PASSWORD
    )


def support_email_configured() -> bool:
    return bool(str(config.SUPPORT_EMAIL or "").strip() and _smtp_configured())


def send_support_ticket_email(*, report: dict[str, Any], reporter: dict[str, Any]) -> bool:
    """Send a newly-created report/ticket to the support inbox.

    Returns False when SMTP is not configured or delivery fails. The caller should
    not fail ticket creation because the ticket is already stored in the database.
    """
    support_email = str(config.SUPPORT_EMAIL or "").strip()
    if not support_email:
        logger.warning("Support ticket email skipped: SUPPORT_EMAIL is empty")
        return False
    if not _smtp_configured():
        logger.warning("Support ticket email skipped: SMTP is not configured")
        return False

    report_id = str(report.get("id") or "")
    report_type = str(report.get("report_type") or "")
    target_id = str(report.get("target_id") or "")
    title = str(report.get("title") or "")
    description = str(report.get("description") or "")
    created_at = str(report.get("created_at") or "")
    reporter_id = str(reporter.get("id") or "")
    reporter_email = str(reporter.get("email") or "")
    reporter_role = str(reporter.get("role") or "")

    subject = f"[MangaHub Ticket] {title[:160] or report_type or report_id}"
    body = "\n".join(
        [
            "MangaHub support ticket",
            "",
            f"Report ID: {report_id}",
            f"Type: {report_type}",
            f"Target ID: {target_id or '-'}",
            f"Title: {title}",
            f"Created at: {created_at or '-'}",
            "",
            "Reporter",
            f"User ID: {reporter_id or '-'}",
            f"Email: {reporter_email or '-'}",
            f"Role: {reporter_role or '-'}",
            "",
            "Description",
            description,
        ]
    )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = config.SMTP_FROM_EMAIL or config.SMTP_USERNAME
    msg["To"] = support_email
    if reporter_email:
        msg["Reply-To"] = reporter_email
    msg.set_content(body)

    try:
        smtp_cls = smtplib.SMTP_SSL if config.SMTP_USE_SSL else smtplib.SMTP
        with smtp_cls(config.SMTP_HOST, config.SMTP_PORT, timeout=config.SMTP_TIMEOUT_SECONDS) as smtp:
            if config.SMTP_USE_TLS and not config.SMTP_USE_SSL:
                smtp.starttls()
            smtp.login(config.SMTP_USERNAME, config.SMTP_PASSWORD)
            smtp.send_message(msg)
        return True
    except Exception:
        logger.exception("Failed to send support ticket email")
        return False
