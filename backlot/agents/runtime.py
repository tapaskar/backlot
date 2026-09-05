"""Run an ADK agent once with a prepared session state and return the state."""
from __future__ import annotations

import json
import logging
from typing import Any

from google.adk.runners import InMemoryRunner
from google.genai import types

log = logging.getLogger("backlot.runtime")
APP = "backlot"


def _stringify(state: dict[str, Any]) -> dict[str, Any]:
    """Instruction templating inserts state values as text; give it JSON, not reprs."""
    return {k: (v if isinstance(v, (str, int, float, bool)) or v is None else json.dumps(v, default=str))
            for k, v in state.items()}


async def run_agent(agent, state: dict[str, Any], message: str = "Begin.") -> dict[str, Any]:
    runner = InMemoryRunner(agent=agent, app_name=APP)
    session = await runner.session_service.create_session(app_name=APP, user_id="crew", state=_stringify(state))
    content = types.Content(role="user", parts=[types.Part(text=message)])
    async for ev in runner.run_async(user_id="crew", session_id=session.id, new_message=content):
        if ev.content and ev.content.parts:
            for part in ev.content.parts:
                if getattr(part, "function_call", None):
                    log.info("%s -> tool %s", ev.author, part.function_call.name)
    session = await runner.session_service.get_session(app_name=APP, user_id="crew", session_id=session.id)
    try:
        await runner.close()
    except Exception:  # pragma: no cover
        pass
    return dict(session.state)


def parse_output(value: Any, model):
    """State holds either the parsed object, a dict, or the model's JSON text."""
    if value is None:
        raise ValueError(f"agent produced no {model.__name__}")
    if isinstance(value, model):
        return value
    if isinstance(value, str):
        txt = value.strip()
        if txt.startswith("```"):
            txt = txt.strip("`")
            txt = txt[txt.find("{"):txt.rfind("}") + 1]
        value = json.loads(txt)
    return model.model_validate(value)
