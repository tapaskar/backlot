"""Shooting-day simulator: turns a planned day into the stream of events a real
set produces - setups, takes, holds, moves, wrap - with seeded chaos so the
Grafana dashboard moves and the director has something to react to.

Deterministic per (project, day, chaos, seed), so demos are repeatable.
"""
from __future__ import annotations

import random

from .schemas import Breakdown, ShootingDay
from .telemetry import telemetry

CAUSES = [  # (cause, minutes lost, weight)
    ("weather hold", 75, 3), ("actor late", 40, 3), ("camera card failure", 30, 2),
    ("location access", 60, 2), ("sound: aircraft", 20, 4), ("generator fault", 90, 1),
    ("permit inspection", 45, 1),
]
MINUTES_PER_DAY = 600          # 10-hour day
SETUP_MIN = (18, 30)           # relight + block per setup; ~22 setups fill a 5-page day
TAKE_MIN = (1.5, 3.0)          # per take, including resets


def run_day(project: str, bd: Breakdown, day: ShootingDay, chaos: float = 0.3, seed: int = 0,
            budget_per_day: float = 0.0) -> dict:
    rng = random.Random(f"{project}:{day.day}:{chaos}:{seed}")
    scenes = {s.number: s for s in bd.scenes}
    clock = 0.0
    completed: list[int] = []
    pushed: list[int] = []
    takes = setups = 0
    delays: dict[str, int] = {}
    P = dict(project=project)

    telemetry.set("backlot_day", day.day, **P)
    telemetry.set("backlot_eighths_planned_today", day.planned_eighths, **P)
    telemetry.set("backlot_eighths_completed_today", 0, **P)
    telemetry.event(project, day.day, "call", f"Crew call {day.call_time} at {day.location}. "
                    f"{len(day.scenes)} scenes, {day.planned_eighths}/8 pages planned.")

    for n in day.scenes:
        s = scenes[n]
        # random hold before the scene?
        if rng.random() < chaos * 0.6:
            cause, mins, _ = rng.choices(CAUSES, weights=[w for _, _, w in CAUSES])[0]
            mins = int(mins * rng.uniform(0.6, 1.4))
            clock += mins
            delays[cause] = delays.get(cause, 0) + mins
            telemetry.inc("backlot_delay_minutes", mins, cause=cause, **P)
            telemetry.event(project, day.day, "hold", f"Hold {mins} min: {cause} (before sc. {n})", scene=n, cause=cause)
        if clock >= MINUTES_PER_DAY:
            pushed.append(n)
            telemetry.event(project, day.day, "push", f"Scene {n} pushed: out of day", scene=n)
            continue
        # coverage: a master, a single per speaking actor (max 3), a wide for exteriors,
        # plus one extra setup per two pages of action
        n_setups = 1 + min(3, len(s.cast)) + (1 if s.int_ext == "EXT" else 0) + s.eighths // 16
        for k in range(n_setups):
            setups += 1
            telemetry.inc("backlot_setups_total", 1, **P)
            t = rng.randint(2, 5) + (1 if rng.random() < chaos else 0)
            takes += t
            telemetry.inc("backlot_takes_total", t, **P)
            clock += rng.uniform(*SETUP_MIN) + t * rng.uniform(*TAKE_MIN) + s.eighths * 2
            telemetry.event(project, day.day, "take", f"Sc. {n} setup {k + 1}/{n_setups}: {t} takes, circled take {t}", scene=n, takes=t)
            if clock >= MINUTES_PER_DAY and k < n_setups - 1:
                break
        if clock >= MINUTES_PER_DAY + 30:      # ran into overtime and did not finish coverage
            pushed.append(n)
            telemetry.event(project, day.day, "push", f"Scene {n} incomplete at wrap: pushed", scene=n)
        else:
            completed.append(n)
            telemetry.inc("backlot_scenes_completed", 1, **P)
            telemetry.inc("backlot_eighths_completed_today", s.eighths, **P)
            telemetry.event(project, day.day, "complete", f"Scene {n} complete ({s.eighths}/8): {s.heading}", scene=n)

    overtime = max(0.0, clock - MINUTES_PER_DAY)
    spent = budget_per_day * (1 + 0.25 * overtime / 60) if budget_per_day else 0.0
    telemetry.inc("backlot_budget_spent_usd", round(spent, 2), **P)
    telemetry.event(project, day.day, "wrap", f"Wrap at +{clock:.0f} min ({overtime:.0f} min overtime). "
                    f"{len(completed)}/{len(day.scenes)} scenes complete, {takes} takes, {setups} setups.")
    telemetry.flush()
    return dict(day=day.day, completed=completed, pushed=pushed, takes=takes, setups=setups,
                delays=delays, overtime_min=round(overtime), minutes=round(clock), spent=round(spent, 2))
