from datetime import datetime, timezone

import pytest

from app.scheduler import ScheduleError, next_run, validate

T = datetime(2026, 11, 9, 13, 30, tzinfo=timezone.utc)  # a Monday


def test_interval():
    s = validate({"type": "interval", "every": 2, "unit": "hours"})
    assert next_run(s, T) == datetime(2026, 11, 9, 15, 30, tzinfo=timezone.utc)
    with pytest.raises(ScheduleError):
        validate({"type": "interval", "every": 1, "unit": "minutes"})


def test_custom_recurrence_picks_earliest_upcoming():
    s = validate({"type": "recurrence", "recurrences": [{"days": [0, 1, 2, 3, 4], "time": "09:00"},
                                                        {"days": [5, 6], "time": "08:00"}]})
    assert next_run(s, T) == datetime(2026, 11, 10, 9, 0, tzinfo=timezone.utc)
    friday_evening = datetime(2026, 11, 13, 20, 0, tzinfo=timezone.utc)
    assert next_run(s, friday_evening) == datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc)


def test_cron():
    s = validate({"type": "cron", "expression": "0 12 * * *"})
    assert next_run(s, T) == datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
    for bad in ("0 12 * *", "0 12 15W * *", "0 12 * * 1#2", "nonsense x x x x"):
        with pytest.raises(ScheduleError):
            validate({"type": "cron", "expression": bad})


def test_manual():
    assert validate(None) == {"type": "manual"} and next_run({"type": "manual"}, T) is None
