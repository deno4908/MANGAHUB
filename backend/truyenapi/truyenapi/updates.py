"""Filter source update labels without treating relative times as exact timestamps."""

import re
import unicodedata
from datetime import date, datetime, time, timedelta, timezone


VIETNAM = timezone(timedelta(hours=7))
AGE_UNITS = {"giay": (1, "second"), "second": (1, "second"),
             "phut": (60, "minute"), "minute": (60, "minute"),
             "gio": (3600, "hour"), "hour": (3600, "hour"),
             "ngay": (86400, "day"), "day": (86400, "day"),
             "tuan": (604800, "week"), "week": (604800, "week")}


def update_interval(label: str | None, observed_at: datetime):
    """Return the possible update interval implied by a label at observation time."""
    label = unicodedata.normalize("NFKD", label or "").lower()
    label = " ".join("".join(c for c in label if not unicodedata.combining(c)).split())
    if label in {"vua xong", "vua cap nhat", "vua moi", "just now"}:
        return observed_at - timedelta(minutes=1), observed_at, "minute", True
    match = re.fullmatch(r"(\d+)\s*(giay|phut|gio|ngay|tuan|second[s]?|minute[s]?|hour[s]?|day[s]?|week[s]?)(?:\s+(?:truoc|ago))?", label)
    if match:
        amount, unit = int(match[1]), match[2]
        seconds, precision = AGE_UNITS[unit.rstrip("s")]
        # Very old/malformed ages are not useful to this feed and can overflow datetime.
        if amount * seconds > timedelta(days=36500).total_seconds():
            return None
        return (observed_at - timedelta(seconds=(amount + 1) * seconds),
                observed_at - timedelta(seconds=amount * seconds), precision, True)
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            start = datetime.combine(datetime.strptime(label, fmt).date(), time.min, VIETNAM)
            return start, start + timedelta(days=1), "day", False
        except ValueError:
            pass
    try:
        instant = datetime.fromisoformat(label.replace("z", "+00:00"))
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=VIETNAM)
        return instant, instant, "second", False
    except ValueError:
        return None


def filter_updates(source: dict, *, now: datetime, within_minutes: int | None = None, day: date | None = None):
    observed = datetime.fromisoformat(source["fetched_at"])
    if day is not None:
        start = datetime.combine(day, time.min, VIETNAM)
        end = start + timedelta(days=1)
    else:
        within_minutes = 60 if within_minutes is None else within_minutes
        start, end = now - timedelta(minutes=within_minutes), now
    items, unknown = [], 0
    for card in source["items"]:
        interval = update_interval(card.get("updated_at"), observed)
        if interval is None:
            unknown += 1
            continue
        lower, upper, precision, estimated = interval
        # Half-open ranges avoid putting midnight into both adjacent dates.
        overlaps = start <= lower < end if lower == upper else lower < end and upper > start
        if overlaps:
            items.append({**card, "update_time_from": lower.isoformat(), "update_time_to": upper.isoformat(),
                          "update_time_precision": precision, "update_time_is_estimated": estimated})
    return {**source, "items": items, "count": len(items), "collection": "latest", "total": None,
            "source_count": len(source["items"]), "unparsed_time_count": unknown,
            "scope": "source_page", "time_filter_mode": "range_overlap", "timezone": "Asia/Ho_Chi_Minh",
            "filter": {"date": day.isoformat() if day else None, "within_minutes": within_minutes if day is None else None,
                       "from": start.isoformat(), "to": end.isoformat()},
            "checked_at": now.isoformat(), "next_poll_seconds": 60}
