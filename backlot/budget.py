"""Deterministic indie-scale budget from a schedule. Every number traces to a
rate-card line, so the producer agent can argue with it but not invent it."""
from __future__ import annotations

from .schemas import Breakdown, Budget, BudgetLine, Schedule

RATE_CARD = {  # USD, per day unless stated - a micro-budget short/feature rate card
    "crew": [("Director of photography", 650), ("1st AC", 400), ("Gaffer", 450), ("Sound mixer", 450),
             ("1st AD", 450), ("Production assistant", 200), ("Hair & makeup", 350)],
    "cast_day": 250,          # SAG-AFTRA micro-budget scale is in this range
    "equipment_day": 900,     # camera package + lights + sound
    "location_day": 400,      # average permit/fee; real locations vary wildly
    "meals_person_day": 28,
    "props_per_scene": 60,
    "night_premium": 0.15,    # crew premium for night days
    "contingency": 0.10,
}


def build_budget(bd: Breakdown, schedule: Schedule) -> Budget:
    lines: list[BudgetLine] = []
    days = schedule.total_days
    night_days = sum(1 for d in schedule.days if "Night" in d.notes)
    crew_n = len(RATE_CARD["crew"])

    for role, rate in RATE_CARD["crew"]:
        lines.append(BudgetLine(category="Crew", item=role, qty=days, unit="day", unit_cost=rate, total=rate * days))
    if night_days:
        crew_day = sum(r for _, r in RATE_CARD["crew"])
        prem = round(crew_day * RATE_CARD["night_premium"], 2)
        lines.append(BudgetLine(category="Crew", item="Night premium", qty=night_days, unit="night day",
                                unit_cost=prem, total=round(prem * night_days, 2)))

    cast_days = sum(len(d.cast) for d in schedule.days)
    lines.append(BudgetLine(category="Cast", item="Day players", qty=cast_days, unit="cast-day",
                            unit_cost=RATE_CARD["cast_day"], total=RATE_CARD["cast_day"] * cast_days))
    lines.append(BudgetLine(category="Equipment", item="Camera, lighting, sound package", qty=days, unit="day",
                            unit_cost=RATE_CARD["equipment_day"], total=RATE_CARD["equipment_day"] * days))
    loc_days = sum(1 + d.location.count(" + ") for d in schedule.days)
    lines.append(BudgetLine(category="Locations", item="Fees and permits", qty=loc_days, unit="location-day",
                            unit_cost=RATE_CARD["location_day"], total=RATE_CARD["location_day"] * loc_days))
    people_days = sum(crew_n + len(d.cast) + 2 for d in schedule.days)
    lines.append(BudgetLine(category="Catering", item="Meals", qty=people_days, unit="person-day",
                            unit_cost=RATE_CARD["meals_person_day"], total=RATE_CARD["meals_person_day"] * people_days))
    lines.append(BudgetLine(category="Art", item="Props and set dressing", qty=len(bd.scenes), unit="scene",
                            unit_cost=RATE_CARD["props_per_scene"], total=RATE_CARD["props_per_scene"] * len(bd.scenes)))

    subtotal = round(sum(l.total for l in lines), 2)
    contingency = round(subtotal * RATE_CARD["contingency"], 2)
    return Budget(lines=lines, subtotal=subtotal, contingency=contingency, total=round(subtotal + contingency, 2),
                  assumptions=[f"{days} shooting days at {schedule.eighths_per_day / 8:.0f} pages/day",
                               f"{crew_n}-person crew, day-player cast at ${RATE_CARD['cast_day']}/day",
                               f"{int(RATE_CARD['contingency'] * 100)}% contingency",
                               "Micro-budget rate card; replace RATE_CARD with your own quotes"])


def planned_spend_by_day(budget: Budget, schedule: Schedule) -> list[float]:
    """Cumulative planned spend after each day - the budget burn line on the dashboard."""
    per_day = budget.total / max(1, schedule.total_days)
    return [round(per_day * (i + 1), 2) for i in range(schedule.total_days)]
