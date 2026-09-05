"""Deterministic core: parser, scheduler, budget, simulator. No network, no LLM."""
from pathlib import Path

from backlot.budget import build_budget
from backlot.fountain import parse_script
from backlot.scheduling import build_schedule, replan
from backlot.simulate import run_day
from backlot.telemetry import telemetry

SCRIPT = (Path(__file__).resolve().parent.parent / "scripts" / "demo_script.fountain").read_text()


def test_parser_finds_scenes_cast_and_locations():
    bd = parse_script(SCRIPT)
    assert bd.title == "THE LAST FERRY"
    assert len(bd.scenes) == 8
    assert bd.scenes[0].heading.startswith("EXT. HARBOUR ROAD")
    assert bd.scenes[0].int_ext == "EXT" and bd.scenes[0].time_of_day == "DAWN"
    assert bd.scenes[2].int_ext == "INT" and bd.scenes[2].location == "WHEELHOUSE"
    assert "MAYA" in bd.characters and "OLD TOM" in bd.characters and "JUNE" in bd.characters
    assert "FADE IN" not in bd.characters and "V.O." not in " ".join(bd.characters)
    assert {"HARBOUR ROAD", "FERRY DECK", "WHEELHOUSE", "TICKET BOOTH"} <= set(bd.locations)
    assert all(s.eighths >= 1 for s in bd.scenes)


def test_schedule_groups_by_location_and_respects_day_cap():
    bd = parse_script(SCRIPT)
    sch = build_schedule(bd, eighths_per_day=12)
    assert sch.total_days >= 2
    assert sorted(n for d in sch.days for n in d.scenes) == [s.number for s in bd.scenes]
    assert all(d.planned_eighths <= 12 or len(d.scenes) == 1 for d in sch.days)
    # same input, same output
    assert build_schedule(bd, 12).model_dump() == sch.model_dump()
    # night scenes come after day scenes within a location
    for d in sch.days:
        tods = [bd.scenes[n - 1].time_of_day for n in d.scenes]
        if "NIGHT" in tods and "DAY" in tods:
            assert tods.index("NIGHT") > tods.index("DAY")


def test_replan_keeps_shot_days_and_pushes_scenes_last():
    bd = parse_script(SCRIPT)
    sch = build_schedule(bd, 12)
    done = set(sch.days[0].scenes)
    not_done = [s.number for s in bd.scenes if s.number not in done]
    pushed = not_done[0]
    new = replan(bd, sch, completed=done, from_day=2, push=[pushed])
    assert new.days[0].model_dump() == sch.days[0].model_dump()
    remaining = sorted(n for d in new.days[1:] for n in d.scenes)
    assert remaining == sorted(not_done)
    assert pushed in new.days[-1].scenes


def test_budget_adds_up():
    bd = parse_script(SCRIPT)
    sch = build_schedule(bd)
    b = build_budget(bd, sch)
    assert abs(sum(l.total for l in b.lines) - b.subtotal) < 0.01
    assert abs(b.subtotal + b.contingency - b.total) < 0.01
    assert b.total > 0 and any(l.category == "Cast" for l in b.lines)


def test_simulator_is_seeded_and_emits_events():
    bd = parse_script(SCRIPT)
    sch = build_schedule(bd, 16)
    r1 = run_day("ferry", bd, sch.days[0], chaos=0.5, seed=1, budget_per_day=1000)
    n_events = len(telemetry.events)
    r2 = run_day("ferry", bd, sch.days[0], chaos=0.5, seed=1, budget_per_day=1000)
    assert r1["completed"] == r2["completed"] and r1["takes"] == r2["takes"]
    assert len(telemetry.events) > n_events
    assert set(r1["completed"]) | set(r1["pushed"]) == set(sch.days[0].scenes)
    assert telemetry.get("backlot_setups_total", project="ferry") > 0
    calm = run_day("calm", bd, sch.days[0], chaos=0.0, seed=1)
    assert calm["pushed"] == [] and calm["delays"] == {}
