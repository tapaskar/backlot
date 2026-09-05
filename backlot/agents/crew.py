"""The agents. Each one has a single job and a typed output.

  script_supervisor  enriches the deterministic parse (props, hazards, synopsis)
  line_producer      reads the schedule + budget and names the risks
  set_investigator   reads today's numbers from Grafana through MCP (facts only)
  director           decides: on track / slipping / over budget, replan or not
  scribe             posts the decision back to Grafana as an annotation (MCP write)
  wrap_investigator  reads the whole production from Grafana
  wrap_writer        turns it into the wrap report

`end_of_day` and `wrap_up` are SequentialAgents: fixed order, no delegation,
so a day always runs the same three steps and every step's output is in
session state for the next one.
"""
from __future__ import annotations

from google.adk.agents import LlmAgent, SequentialAgent

from ..schemas import Breakdown, DirectorNote, ProducerNotes, WrapReport
from .grafana_mcp import READ_TOOLS, WRITE_TOOLS, grafana_toolset
from .models import model_spec


def script_supervisor() -> LlmAgent:
    return LlmAgent(
        name="script_supervisor", model=model_spec(), output_schema=Breakdown, output_key="breakdown",
        description="Enriches a parsed screenplay breakdown.",
        instruction="""You are a film script supervisor preparing a breakdown for scheduling.
You receive a screenplay and a deterministic parse of it as JSON (scene numbers, headings,
INT/EXT, location, time of day, page eighths, cast).

Return the same Breakdown, enriched:
- props: physical items each scene needs (specific, e.g. "thermos", "council clipboard");
- notes: anything that changes the schedule or budget - stunts, animals, vehicles, water,
  minors, weather-dependent exteriors, night work, VFX, crowd. Empty string if nothing.
- synopsis: one sentence per scene.
- logline: one sentence for the whole script.

Rules: never add, remove, merge or renumber scenes; never change headings, locations,
time_of_day, eighths or cast. If the parse says 8 scenes, you return 8 scenes.""")


def line_producer() -> LlmAgent:
    return LlmAgent(
        name="line_producer", model=model_spec(), output_schema=ProducerNotes, output_key="producer_notes",
        description="Reviews the schedule and budget for risk.",
        instruction="""You are an experienced independent-film line producer.
You receive the breakdown, the shooting schedule (packed by a deterministic scheduler) and
the budget (from a fixed rate card) as JSON.

Write ProducerNotes:
- risks: concrete, ranked, with numbers ("Day 2 carries 38/8 pages across two locations with
  a company move; over 5 pages/day is the single most common cause of overtime").
- suggestions: cheap changes - reorder, split a day, drop a company move, shoot a night
  scene day-for-night, cover a scene in fewer setups.
- summary: three sentences a director will actually read.
Do not restate the schedule. Do not invent scenes or costs that are not in the input.""")


def set_investigator() -> LlmAgent:
    return LlmAgent(
        name="set_investigator", model=model_spec(), output_key="evidence",
        description="Reads today's production numbers from Grafana.",
        tools=[grafana_toolset(READ_TOOLS)],
        instruction="""You are the production coordinator. Read today's numbers for the film
project "{slug}" (shooting day {day}) from Grafana, using the tools, and report facts only.

Procedure:
1. list_datasources; note the UIDs of the Prometheus and Loki datasources.
2. query_prometheus (instant queries) for each of:
   backlot_eighths_planned_today{{project="{slug}"}}, backlot_eighths_completed_today{{project="{slug}"}},
   backlot_scenes_completed{{project="{slug}"}}, backlot_scenes_total{{project="{slug}"}},
   backlot_budget_spent_usd{{project="{slug}"}}, backlot_budget_planned_usd{{project="{slug}"}},
   sum by (cause) (backlot_delay_minutes{{project="{slug}"}}).
3. query_loki_logs with query {{service_name="backlot"}} | project="{slug}" for the last 12 hours,
   limit 60, and pull out holds, pushes and the wrap line.
4. search_dashboards for "Backlot: " and generate_deeplink to the project's dashboard.

Output: a numbered list of facts, each with its number and unit, then the dashboard link.
If a tool fails, say which one and what you could still establish. Do not interpret or decide.""")


def director() -> LlmAgent:
    return LlmAgent(
        name="director", model=model_spec(), output_schema=DirectorNote, output_key="director_note",
        description="Decides what changes tomorrow.",
        instruction="""You are the director at the end of shooting day {day} on "{title}".

Evidence gathered from Grafana by the coordinator:
{evidence}

The plan for the remaining days (JSON): {remaining_plan}
Scenes already completed: {completed}

Decide, and return a DirectorNote:
- status: on_track if today's pages shot >= 85% of planned and budget spent <= planned to date;
  slipping if pages < 85% of planned; over_budget if spend exceeds plan to date by >10%;
  blocked only if the evidence shows a hard stop (location lost, key cast unavailable).
- evidence: the 3-6 facts (with numbers) that drove the decision.
- decision: one paragraph, in the voice of a director talking to their 1st AD.
- replan: true when status is not on_track and pushed scenes exist or tomorrow is overloaded.
- move_scenes: scene numbers to push to the end of the schedule (only scenes not yet completed).
Ground every number in the evidence; if the evidence is missing a number, say so rather than guess.""")


def scribe() -> LlmAgent:
    return LlmAgent(
        name="scribe", model=model_spec(), output_key="annotation_result",
        description="Posts the director's note to Grafana as an annotation.",
        tools=[grafana_toolset(WRITE_TOOLS)],
        instruction="""Post the director's end-of-day note for project "{slug}", day {day}, as a Grafana
annotation using create_annotation. Text: "Day {day} - <status>: <decision>" built from this note:
{director_note}
Tags: backlot, {slug}, day-{day}, <status>. Reply with the annotation id, or the error.""")


def wrap_investigator() -> LlmAgent:
    return LlmAgent(
        name="wrap_investigator", model=model_spec(), output_key="evidence",
        description="Reads the whole production from Grafana.",
        tools=[grafana_toolset(READ_TOOLS)],
        instruction="""Read the full production record for film project "{slug}" from Grafana.
list_datasources; then query_prometheus for backlot_scenes_completed, backlot_scenes_total,
backlot_budget_spent_usd, backlot_budget_planned_usd, backlot_takes_total, backlot_setups_total and
sum by (cause) (backlot_delay_minutes) - all with {{project="{slug}"}} - and query_loki_logs for
{{service_name="backlot"}} | project="{slug}" |= "Wrap" over the last 7 days, limit 100.
Report a numbered list of facts with numbers. Facts only.""")


def wrap_writer() -> LlmAgent:
    return LlmAgent(
        name="wrap_writer", model=model_spec(), output_schema=WrapReport, output_key="wrap_report",
        description="Writes the wrap report.",
        instruction="""Write the wrap report for "{title}".
Evidence from Grafana: {evidence}
Director's notes by day: {director_notes}
Plan: {plan_summary}

Fill every numeric field from the evidence; highlights are the three best moments (a scene that
came in under time, a good decision, a lucky break); lessons are three things the next shoot
should do differently, each tied to a number. The narrative is 150-200 words, warm, specific,
no marketing language.""")


def end_of_day() -> SequentialAgent:
    return SequentialAgent(name="end_of_day", description="investigate -> decide -> annotate",
                           sub_agents=[set_investigator(), director(), scribe()])


def wrap_up() -> SequentialAgent:
    return SequentialAgent(name="wrap_up", description="investigate -> write",
                           sub_agents=[wrap_investigator(), wrap_writer()])
