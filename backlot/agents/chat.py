"""Multi-turn sessions with the front desk, one per project (or the lobby)."""
from __future__ import annotations

import logging

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from .front_desk import build_front_desk

log = logging.getLogger("backlot.chat")
APP = "backlot-front-desk"
USER = "crew"
_runner: Runner | None = None


def runner() -> Runner:
    global _runner
    if _runner is None:
        _runner = Runner(agent=build_front_desk(), app_name=APP, session_service=InMemorySessionService())
    return _runner


async def ask(session_id: str, message: str) -> dict:
    r = runner()
    session = await r.session_service.get_session(app_name=APP, user_id=USER, session_id=session_id)
    if session is None:
        session = await r.session_service.create_session(app_name=APP, user_id=USER, session_id=session_id)
    content = types.Content(role="user", parts=[types.Part(text=message)])
    reply, author, tools = [], None, []
    async for ev in r.run_async(user_id=USER, session_id=session.id, new_message=content):
        if ev.content and ev.content.parts:
            for part in ev.content.parts:
                if getattr(part, "function_call", None):
                    tools.append(part.function_call.name)
                if ev.is_final_response() and getattr(part, "text", None):
                    reply.append(part.text); author = ev.author
    return {"session_id": session.id, "author": author, "tools": tools, "reply": "\n".join(reply).strip()}
