"""The production pipeline: three deterministic multi-step flows.

  greenlight(project)      parse -> script_supervisor -> schedule -> budget -> line_producer
                           -> Grafana dashboard -> plan metrics
  shoot_day(project, ...)  simulate the day -> end_of_day (investigate via Grafana MCP,
                           decide, annotate via Grafana MCP) -> replan if the director says so
  wrap(project)            wrap_up (investigate via Grafana MCP, write)

Every LLM step has an offline fallback (BACKLOT_OFFLINE=1 or no Gemini credentials)
so the product, the UI and the tests run end to end without network; the fallbacks are
rule-based and clearly marked in the output.
"""
from __future__ import annotations

import logging
import os

from . import config
from .agents import crew
from .agents.grafana_mcp import grafana_configured
from .agents.runtime import parse_output, run_agent
from .budget import build_budget, planned_spend_by_day
from .fountain import parse_script
from .scheduling import build_schedule, replan
from .schemas import Breakdown, DirectorNote, ProducerNotes, WrapReport
from .simulate import run_day
from .store import DayRecord, Project, store
from .telemetry import telemetry

log = logging.getLogger("backlot.pipeline")


def offline() -> bool:
    if os.environ.get("BACKLOT_OFFLINE", "").lower() in ("1", "true", "yes"):
        return True
    vertex = os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").upper() == "TRUE"
    return not (os.environ.get("GOOGLE_API_KEY") or (vertex and os.environ.get("GOOGLE_CLOUD_PROJECT")))


# ------------------------------------------------------------------ greenlight
async def greenlight(p: Project, eighths_per_day: int = 40) -> Project:
    parsed = parse_script(p.script, p.title)
    if offline():
        bd = parsed
        bd.logline = "(offline) breakdown from the deterministic parser only"
    else:
        state = await run_agent(crew.script_supervisor(), {"parsed": parsed.model_dump()},
                                f"Screenplay:\n\n{p.script}\n\nDeterministic parse (JSON):\n{parsed.model_dump_json()}")
        bd = parse_output(state.get("breakdown"), Breakdown)
        bd = _guard_breakdown(parsed, bd)
    p.breakdown = bd
    p.schedule = build_schedule(bd, eighths_per_day)
    p.budget = build_budget(bd, p.schedule)

    if offline():
        p.producer_notes = _offline_producer_notes(p)
    else:
        state = await run_agent(crew.line_producer(), {}, "Breakdown:\n" + bd.model_dump_json() +
                                "\n\nSchedule:\n" + p.schedule.model_dump_json() + "\n\nBudget:\n" + p.budget.model_dump_json())
        p.producer_notes = parse_output(state.get("producer_notes"), ProducerNotes)

    if config.GRAFANA_SERVICE_ACCOUNT_TOKEN:
        try:
            from .grafana_provision import create_dashboard
            p.dashboard = create_dashboard(p.slug, p.title)
        except Exception as e:  # dashboard is a convenience; the shoot must not depend on it
            log.warning("dashboard not created: %s", e)
            p.dashboard = {"error": str(e)}
    _push_plan(p)
    p.status = "greenlit"
    return store.save(p)


def _guard_breakdown(parsed: Breakdown, bd: Breakdown) -> Breakdown:
    """The supervisor may enrich, never restructure. Restore anything it changed."""
    if len(bd.scenes) != len(parsed.scenes):
        log.warning("supervisor changed scene count %d -> %d; keeping parse", len(parsed.scenes), len(bd.scenes))
        return parsed
    for a, b in zip(parsed.scenes, bd.scenes):
        b.number, b.heading, b.int_ext, b.location, b.time_of_day, b.eighths, b.cast = \
            a.number, a.heading, a.int_ext, a.location, a.time_of_day, a.eighths, a.cast
    bd.characters, bd.locations, bd.title = parsed.characters, parsed.locations, parsed.title
    return bd


def _offline_producer_notes(p: Project) -> ProducerNotes:
    risks, sugg = [], []
    for d in p.schedule.days:
        if d.planned_eighths > p.schedule.eighths_per_day * 0.9:
            risks.append(f"Day {d.day} is at {d.planned_eighths}/8 pages, near the {p.schedule.eighths_per_day}/8 cap.")
        if "Company move" in d.notes:
            risks.append(f"Day {d.day} has a company move ({d.location}).")
            sugg.append(f"Split day {d.day} or shoot both locations' scenes back to back.")
        if "Night" in d.notes:
            sugg.append(f"Day {d.day} is night work: confirm crew turnaround and a 14:00 call.")
    return ProducerNotes(risks=risks or ["No structural risks found by the offline rules."],
                         suggestions=sugg or ["Keep the plan."],
                         summary=f"(offline) {p.schedule.total_days} days, ${p.budget.total:,.0f} planned.")


def _push_plan(p: Project):
    P = dict(project=p.slug)
    telemetry.set("backlot_scenes_total", len(p.breakdown.scenes), **P)
    telemetry.set("backlot_scenes_completed", len(p.completed), **P)
    telemetry.set("backlot_budget_planned_usd", p.budget.total, **P)
    telemetry.set("backlot_budget_spent_usd", p.spent, **P)
    telemetry.set("backlot_days_planned", p.schedule.total_days, **P)
    telemetry.event(p.slug, 0, "plan", f"Greenlit: {p.schedule.total_days} days, {len(p.breakdown.scenes)} scenes, "
                    f"${p.budget.total:,.0f}.")
    telemetry.flush()


# ------------------------------------------------------------------- shoot day
async def shoot_day(p: Project, chaos: float = 0.3, seed: int = 0) -> Project:
    if p.schedule is None:
        raise ValueError("greenlight the project first")
    n = p.next_day
    plan = next((d for d in p.schedule.days if d.day == n), None)
    if plan is None:
        raise ValueError("no days left in the schedule")
    per_day = p.budget.total / max(1, p.schedule.total_days)
    sim = run_day(p.slug, p.breakdown, plan, chaos=chaos, seed=seed, budget_per_day=per_day)
    p.completed = sorted(set(p.completed) | set(sim["completed"]))
    p.spent = round(p.spent + sim["spent"], 2)
    telemetry.set("backlot_scenes_completed", len(p.completed), project=p.slug)
    telemetry.set("backlot_budget_spent_usd", p.spent, project=p.slug)
    telemetry.flush()

    remaining = [d.model_dump() for d in p.schedule.days if d.day > n]
    note = await _decide(p, n, sim, remaining)
    rec = DayRecord(day=n, simulation=sim, director=note)
    # pushed scenes must be re-packed whatever the director says; the director's
    # move_scenes additionally go to the end of the schedule
    if sim["pushed"] or (note.replan and note.move_scenes):
        p.schedule = replan(p.breakdown, p.schedule, set(p.completed), from_day=n + 1,
                            push=[s for s in note.move_scenes if s not in p.completed])
        rec.replanned = True
        telemetry.set("backlot_days_planned", p.schedule.total_days, project=p.slug)
        telemetry.event(p.slug, n, "replan", f"Replanned: now {p.schedule.total_days} days; "
                        f"pushed {note.move_scenes or sim['pushed']}.")
        telemetry.flush()
    p.days.append(rec)
    p.status = "shooting" if any(d.day > n for d in p.schedule.days) else "shot"
    return store.save(p)


async def _decide(p: Project, day: int, sim: dict, remaining: list[dict]) -> DirectorNote:
    if offline() or not grafana_configured():
        return _offline_director(p, day, sim, remaining)
    state = await run_agent(crew.end_of_day(), {
        "slug": p.slug, "title": p.title, "day": day, "completed": p.completed,
        "remaining_plan": remaining}, f"End of day {day}. Investigate, decide, annotate.")
    note = parse_output(state.get("director_note"), DirectorNote)
    note.day = day
    return note


def _offline_director(p: Project, day: int, sim: dict, remaining: list[dict]) -> DirectorNote:
    """Rule-based stand-in with the same contract; reads the in-memory telemetry."""
    planned = telemetry.get("backlot_eighths_planned_today", project=p.slug) or 1
    shot = telemetry.get("backlot_eighths_completed_today", project=p.slug)
    pct = 100 * shot / planned
    planned_to_date = planned_spend_by_day(p.budget, p.schedule)[min(day, p.schedule.total_days) - 1]
    status = "on_track"
    if pct < 85:
        status = "slipping"                  # the actionable one: it triggers a replan
    elif p.spent > planned_to_date * 1.10:
        status = "over_budget"
    delays = ", ".join(f"{c} {m} min" for c, m in sim["delays"].items()) or "no holds"
    evidence = [f"pages shot today {shot:.0f}/8 of {planned:.0f}/8 planned ({pct:.0f}%)",
                f"scenes complete {len(p.completed)} of {len(p.breakdown.scenes)}",
                f"budget spent ${p.spent:,.0f} vs ${planned_to_date:,.0f} planned to date",
                f"holds: {delays}", f"overtime {sim['overtime_min']} min"]
    pushed = sim["pushed"]
    decision = {"on_track": f"Good day. Tomorrow as planned: {remaining[0]['location'] if remaining else 'wrap'}.",
                "slipping": f"We lost {planned - shot:.0f}/8 pages to {delays}. Pushing {pushed or 'nothing'} to the end and repacking the remaining days.",
                "over_budget": f"Spend is {p.spent / max(1, planned_to_date) * 100 - 100:.0f}% over plan to date; cutting the company moves and holding the schedule."}[status]
    return DirectorNote(day=day, status=status, evidence=evidence, decision="(offline) " + decision,
                        replan=bool(pushed), move_scenes=pushed)


# ------------------------------------------------------------------------ wrap
async def wrap(p: Project) -> Project:
    if not p.days:
        raise ValueError("nothing shot yet")
    plan_summary = dict(days_planned=len(p.days) + sum(1 for d in p.schedule.days if d.day > len(p.days)),
                        scenes_total=len(p.breakdown.scenes), budget_planned=p.budget.total)
    notes = [d.director.model_dump() for d in p.days if d.director]
    if offline() or not grafana_configured():
        p.wrap = _offline_wrap(p, plan_summary)
    else:
        state = await run_agent(crew.wrap_up(), {"slug": p.slug, "title": p.title, "director_notes": notes,
                                                 "plan_summary": plan_summary}, "Wrap the production.")
        p.wrap = parse_output(state.get("wrap_report"), WrapReport)
    p.status = "wrapped"
    telemetry.event(p.slug, len(p.days), "wrap_report", f"Wrapped: {p.wrap.scenes_completed}/{p.wrap.scenes_total} scenes, "
                    f"${p.wrap.budget_spent:,.0f} of ${p.wrap.budget_planned:,.0f}.")
    telemetry.flush()
    return store.save(p)


def _offline_wrap(p: Project, plan: dict) -> WrapReport:
    takes = telemetry.get("backlot_takes_total", project=p.slug)
    slips = [d for d in p.days if d.director and d.director.status != "on_track"]
    return WrapReport(
        title=p.title, days_planned=plan["days_planned"], days_shot=len(p.days),
        scenes_completed=len(p.completed), scenes_total=plan["scenes_total"],
        budget_planned=p.budget.total, budget_spent=p.spent,
        highlights=[f"{len(p.completed)} of {plan['scenes_total']} scenes in the can",
                    f"{takes:.0f} takes across {len(p.days)} days",
                    f"{len(p.days) - len(slips)} of {len(p.days)} days on track"],
        lessons=[f"{len(slips)} day(s) needed a replan" if slips else "No replans needed",
                 f"Budget landed at {100 * p.spent / max(1, p.budget.total):.0f}% of plan",
                 "Replace the offline rules with the Gemini crew for real notes"],
        narrative=f"(offline) {p.title} shot {len(p.completed)} of {plan['scenes_total']} scenes in {len(p.days)} days.")
