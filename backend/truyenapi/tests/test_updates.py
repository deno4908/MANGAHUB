from datetime import date, datetime, timedelta, timezone

import pytest

from truyenapi.updates import VIETNAM, filter_updates, update_interval


NOW = datetime(2026, 10, 20, 0, 2, tzinfo=VIETNAM)


def source(*labels, observed=NOW):
    return {"items": [{"id": str(i), "updated_at": label} for i, label in enumerate(labels)],
            "fetched_at": observed.isoformat(), "page": 3, "has_next": True, "total_pages": 10}


@pytest.mark.parametrize("label", ["5 Phút Trước", "5 phút trước", "5 minutes ago"])
def test_relative_minutes_have_a_range_instead_of_a_fake_exact_timestamp(label):
    lower, upper, precision, estimated = update_interval(label, NOW)
    assert (lower, upper) == (NOW - timedelta(minutes=6), NOW - timedelta(minutes=5))
    assert precision == "minute" and estimated


def test_cached_relative_labels_do_not_move_forward_with_the_request_clock():
    snapshot = source("5 Phút Trước")
    assert filter_updates(snapshot, now=NOW, within_minutes=10)["count"] == 1
    # At this point the same snapshot describes a 10-11 minute old update.
    result = filter_updates(snapshot, now=NOW + timedelta(minutes=5), within_minutes=10)
    assert result["count"] == 0
    assert snapshot["items"][0] == {"id": "0", "updated_at": "5 Phút Trước"}


def test_date_uses_vietnam_midnight_even_when_requested_in_utc():
    result = filter_updates(source("5 Phút Trước", "1 Phút Trước", "unknown", None),
                            now=NOW.astimezone(timezone.utc), day=date(2026, 10, 19))
    assert [item["id"] for item in result["items"]] == ["0"]
    assert result["unparsed_time_count"] == 2
    assert result["filter"]["from"] == "2026-10-19T00:00:00+07:00"
    assert result["source_count"] == 4 and result["count"] == 1
    assert result["page"] == 3 and result["has_next"]


def test_coarse_time_ranges_can_overlap_dates_and_are_marked_estimated():
    result = filter_updates(source("1 Giờ Trước"), now=NOW, day=date(2026, 10, 19))
    assert result["count"] == 1
    assert result["items"][0]["update_time_precision"] == "hour"
    assert result["items"][0]["update_time_is_estimated"]


def test_exact_midnight_belongs_only_to_the_new_day():
    snapshot = source("2026-10-20T00:00:00+07:00")
    assert filter_updates(snapshot, now=NOW, day=date(2026, 10, 19))["count"] == 0
    result = filter_updates(snapshot, now=NOW, day=date(2026, 10, 20))
    assert result["count"] == 1
    assert not result["items"][0]["update_time_is_estimated"]


@pytest.mark.parametrize("label", ["20/10/2026", "20-10-2026", "2026-10-20"])
def test_absolute_dates_keep_day_precision(label):
    lower, upper, precision, estimated = update_interval(label, NOW)
    assert lower == NOW.replace(minute=0)
    assert upper - lower == timedelta(days=1)
    assert precision == "day" and not estimated


@pytest.mark.parametrize("label", ["không rõ", "1 Tháng Trước", "999999999999999999999 Giờ Trước"])
def test_unknown_or_unsafe_relative_times_are_not_invented(label):
    assert update_interval(label, NOW) is None
