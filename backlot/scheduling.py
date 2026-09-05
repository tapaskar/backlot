"""Deterministic shooting-schedule packer.

The rules a first assistant director applies by hand:
  * shoot everything at one location before moving - a company move costs time;
  * inside a location, day scenes before night scenes;
  * cap each day at a page budget (default 5 pages = 40 eighths);
  * a new location on the same day costs a move overhead.
Same input, same schedule. The agents reason *about* this plan; they never
write the plan themselves, which is what keeps the pipeline auditable.
"""
from __future__ import annotations

from .schemas import Breakdown, Scene, Schedule, ShootingDay

MOVE_OVERHEAD = 6            # eighths of capacity lost to a company move
TOD_ORDER = {"DAWN": 0, "SUNRISE": 0, "MORNING": 1, "DAY": 2, "AFTERNOON": 3, "CONTINUOUS": 3,
             "LATER": 3, "DUSK": 4, "MAGIC HOUR": 4, "SUNSET": 4, "EVENING": 5, "NIGHT": 6}


def _by_location(scenes: list[Scene]) -> list[tuple[str, list[Scene]]]:
    groups: dict[str, list[Scene]] = {}
    for s in scenes:
        groups.setdefault(s.location, []).append(s)
    for g in groups.values():
        g.sort(key=lambda s: (TOD_ORDER.get(s.time_of_day, 3), s.number))
    # heaviest locations first: they anchor the schedule
    return sorted(groups.items(), key=lambda kv: (-sum(s.eighths for s in kv[1]), kv[0]))


def pack(scenes: list[Scene], eighths_per_day: int = 40, start_day: int = 1) -> list[ShootingDay]:
    days: list[ShootingDay] = []
    cur: ShootingDay | None = None
    used = 0
    today: list[str] = []          # locations visited today, in order

    def new_day(location: str):
        nonlocal cur, used, today
        cur = ShootingDay(day=start_day + len(days), location=location, scenes=[], planned_eighths=0)
        days.append(cur)
        used = 0
        today = [location]

    for location, group in _by_location(scenes):
        for s in group:
            cost = s.eighths
            if cur is None:
                new_day(location)
            elif location not in today:
                # move only if the rest of the day can still take the scene
                if used + MOVE_OVERHEAD + cost <= eighths_per_day:
                    used += MOVE_OVERHEAD
                    today.append(location)
                    cur.location = " + ".join(today)
                    moves = len(today) - 1
                    cur.notes = f"{moves} company move{'s' if moves > 1 else ''}." + \
                        (" Night work: late call." if "Night" in cur.notes else "")
                else:
                    new_day(location)
            elif used + cost > eighths_per_day and cur.scenes:
                new_day(location)
            cur.scenes.append(s.number)
            cur.planned_eighths += cost
            used += cost
            for c in s.cast:
                if c not in cur.cast:
                    cur.cast.append(c)
            if TOD_ORDER.get(s.time_of_day, 3) >= 6 and "Night" not in cur.notes:
                cur.notes = (cur.notes + " Night work: late call.").strip()
            if TOD_ORDER.get(s.time_of_day, 3) >= 6 and not cur.notes.startswith("Night") and "company move" not in cur.notes:
                cur.notes = cur.notes.strip()
    for d in days:
        if "Night" in d.notes:
            d.call_time = "14:00"
    return days


def build_schedule(bd: Breakdown, eighths_per_day: int = 40) -> Schedule:
    days = pack(bd.scenes, eighths_per_day)
    return Schedule(days=days, eighths_per_day=eighths_per_day, total_days=len(days),
                    total_eighths=sum(s.eighths for s in bd.scenes))


def replan(bd: Breakdown, schedule: Schedule, completed: set[int], from_day: int,
           push: list[int] | None = None) -> Schedule:
    """Re-pack everything not yet shot, starting at `from_day`.

    `push` lists scenes the director wants moved later; they are packed last so
    they land at the end of the schedule rather than tomorrow.
    """
    remaining = [s for s in bd.scenes if s.number not in completed]
    pushed = set(push or [])
    first = [s for s in remaining if s.number not in pushed]
    last = [s for s in remaining if s.number in pushed]
    # days already shot keep their record, but only the scenes that were actually
    # completed: anything pushed is re-packed below, so every scene appears once
    kept = [d.model_copy(update={"scenes": [n for n in d.scenes if n in completed]})
            for d in schedule.days if d.day < from_day]
    new = pack(first, schedule.eighths_per_day, start_day=from_day)
    if last:
        new += pack(last, schedule.eighths_per_day, start_day=from_day + len(new))
    days = kept + new
    return Schedule(days=days, eighths_per_day=schedule.eighths_per_day, total_days=len(days),
                    total_eighths=schedule.total_eighths)
