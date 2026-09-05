"""The Agent Studio export, as wired into Backlot: tree shape, names, tools, model routing."""
import os

import pytest
from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool

from backlot.agents import front_desk
from backlot.agents.models import GlobalGemini, model_spec, using_vertex


def test_tree_shape_and_names():
    root = front_desk.build_front_desk()
    assert root.name == "backlot_production_director" and root.name.isidentifier()
    subs = {a.name: a for a in root.sub_agents}
    assert set(subs) == {"screenplay_agent", "prompt_pipeline_agent", "doc_code_specialist"}
    for name in subs:                       # the coordinator's instruction names its real sub-agents
        assert f"`{name}`" in root.instruction
    assert all(isinstance(t, AgentTool) for t in root.tools) and len(root.tools) == 2
    tool_names = sorted(t.agent.name for t in root.tools)
    assert tool_names == ["director_google_search", "director_url_context"]
    # prompt engineer has its own search/url agents (an agent has one parent)
    pp = sorted(t.agent.name for t in subs["prompt_pipeline_agent"].tools)
    assert pp == ["prompt_pipeline_google_search", "prompt_pipeline_url_context"]
    all_names = [root.name] + list(subs) + tool_names + pp
    assert len(all_names) == len(set(all_names)), "agent names must be unique in the tree"


def test_builtin_tools_are_isolated_per_agent():
    root = front_desk.build_front_desk()
    for t in root.tools:
        inner: LlmAgent = t.agent
        assert len(inner.tools) == 1, "a built-in tool must be the only tool on its agent"
        assert not inner.sub_agents


def test_screenwriter_is_told_to_write_fountain():
    a = front_desk.screenplay_agent()
    assert "INT." in a.instruction and "Title:" in a.instruction


def test_prompt_engineer_knows_the_telemetry_contract():
    a = front_desk.prompt_pipeline_agent()
    assert "backlot_eighths_completed_today" in a.instruction


def test_model_routing(monkeypatch):
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "TRUE")
    m = model_spec("gemini-3.5-flash")
    assert isinstance(m, GlobalGemini) and m.model == "gemini-3.5-flash"
    assert "api_client" not in m.__dict__, "client must be lazy: no credentials needed to build the tree"
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "FALSE"); monkeypatch.setenv("GOOGLE_API_KEY", "x")
    assert not using_vertex() and model_spec("gemini-3.5-flash") == "gemini-3.5-flash"


def test_module_level_root_agent_exists_for_adk_cli():
    from adk_agents.backlot_director import agent
    assert agent.root_agent.name == "backlot_production_director"
    assert front_desk.root_agent.name == agent.root_agent.name
