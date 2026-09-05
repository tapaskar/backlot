"""The front desk: a conversational production director for filmmakers.

Exported from Agent Studio and cleaned up. A root coordinator delegates to three
specialists and can research with Google Search and URL context:

  backlot_production_director   coordinator (root)
    screenplay_agent            scripts, scene outlines, arcs - in Fountain form,
                                so the result drops straight into Backlot's parser
    prompt_pipeline_agent       shot lists, AI-video generation prompts, pipeline
                                and Grafana metric specs (uses search + url tools)
    doc_code_specialist         code, scripts, READMEs for the crew's repos

Built-in tools (Google Search, URL context) cannot share an agent with other
tools, so each lives in its own small agent wrapped as an AgentTool, exactly as
Agent Studio exports them. Every parent gets its own tool-agent instances: an
ADK agent has one parent.

`build_front_desk()` returns a fresh tree; `root_agent` is the module-level
instance the ADK CLI (`adk web`, `adk deploy`) looks for.
"""
from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.tools import url_context
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.google_search_tool import GoogleSearchTool

from .models import model_spec

TELEMETRY_CONTRACT = """Backlot's production telemetry contract (Prometheus metric names, all labelled
project=<slug>): backlot_scenes_total, backlot_scenes_completed, backlot_eighths_planned_today,
backlot_eighths_completed_today, backlot_delay_minutes{cause}, backlot_budget_planned_usd,
backlot_budget_spent_usd, backlot_takes_total, backlot_setups_total, backlot_day, backlot_days_planned.
Logs are Loki lines with labels service_name="backlot", project, day, kind (call|hold|take|complete|push|wrap|replan)."""


def _search_agent(prefix: str) -> LlmAgent:
    return LlmAgent(
        name=f"{prefix}_google_search", model=model_spec(),
        description="Performs Google searches for production references and technical specifications.",
        instruction="Use the Google Search tool to find current, citable information. Return the facts "
                    "found with their sources; do not pad.",
        tools=[GoogleSearchTool()])


def _url_agent(prefix: str) -> LlmAgent:
    return LlmAgent(
        name=f"{prefix}_url_context", model=model_spec(),
        description="Fetches and summarises the content of URLs the user or a search provided.",
        instruction="Use the URL context tool to retrieve the page content, then answer with what it "
                    "actually says. Quote numbers and names exactly.",
        tools=[url_context])


def screenplay_agent() -> LlmAgent:
    return LlmAgent(
        name="screenplay_agent", model=model_spec(),
        description="Develops scripts, scene outlines, character arcs and cinematic story structure.",
        instruction="""You are a creative screenwriting specialist. Write structured scripts, scene
treatments, dialogue and cinematic outlines.

When you write script pages, use Fountain conventions so the result can be scheduled without editing:
a `Title:` line first; every scene starts with a heading line `INT.` or `EXT.` + LOCATION + ` - ` +
DAY/NIGHT/DAWN/DUSK; character names in CAPITALS on their own line above their dialogue;
parentheticals in (brackets); action in plain paragraphs. Keep each scene self-contained and give
every location a consistent name, because the schedule groups scenes by location.""")


def prompt_pipeline_agent() -> LlmAgent:
    p = "prompt_pipeline"
    return LlmAgent(
        name="prompt_pipeline_agent", model=model_spec(),
        description="Generates AI-video generation prompts, shot parameters and pipeline telemetry "
                    "configurations for automated video workflows.",
        instruction=f"""You are an AI video prompt engineer and pipeline architect. Convert screenplay scenes
into structured video-generation prompts with specific camera angles, lens and lighting, motion
parameters, duration and aesthetic style - one prompt per shot, numbered, with the scene and shot id.

When asked for pipeline or monitoring specs, draft configuration steps and Grafana metric definitions
that fit the existing contract rather than inventing new names:
{TELEMETRY_CONTRACT}
Propose new metrics only for things that contract does not cover (render queue depth, seconds of
footage generated, cost per generated second), with a name in the same style and a one-line meaning.
Use the search and URL tools when a model's parameters or a tool's limits need checking.""",
        tools=[AgentTool(agent=_search_agent(p)), AgentTool(agent=_url_agent(p))])


def doc_code_specialist() -> LlmAgent:
    return LlmAgent(
        name="doc_code_specialist", model=model_spec(),
        description="Drafts code snippets, pipeline scripts, README files and repository documentation.",
        instruction="""You are a software documentation and coding specialist for media pipelines. Write clean,
runnable code and comprehensive README documentation: setup, usage, and workflow sections that a
crew can paste into their repository. State assumptions and required credentials explicitly; never
include real secrets.""")


def build_front_desk() -> LlmAgent:
    p = "director"
    return LlmAgent(
        name="backlot_production_director", model=model_spec(),
        description="Coordinates the media production workflow by delegating creative writing, scene "
                    "breakdown, prompt engineering and pipeline configuration.",
        instruction="""You are the lead production coordinator for entertainment media workflows. You help
filmmakers, screenwriters and studio crews get from an idea to a shootable, monitorable production.

Delegate:
- script development, story arcs, scene outlines and screenplay pages to `screenplay_agent`;
- shot lists, AI-video generation prompts, pipeline steps and Grafana metric specs to `prompt_pipeline_agent`;
- code snippets, scripts, README and repository documentation to `doc_code_specialist`.
Use the Google Search and URL context tools yourself to research production references or technical
specifications when a question needs facts you do not have.

Backlot, the app you live in, can take a Fountain-formatted script and break it down, schedule it,
budget it and monitor the shoot in Grafana. When a user wants to produce what was written, tell them
to send the script to the breakdown ("Use this as the script"), and keep your own answers short.""",
        sub_agents=[screenplay_agent(), prompt_pipeline_agent(), doc_code_specialist()],
        tools=[AgentTool(agent=_search_agent(p)), AgentTool(agent=_url_agent(p))])


root_agent = build_front_desk()
