"""Model selection for every Backlot agent.

Gemini 3.x models on Vertex AI are served from the `global` location. The stock
ADK `Gemini` model builds a `google.genai.Client` whose location defaults to the
runtime's region (an Agent Engine instance in `us-central1`, a Cloud Run service
in `europe-west1`), and the request fails with model-not-found. `GlobalGemini`
overrides the client per the pattern documented on
`google.adk.models.google_llm.Gemini`, so the agent keeps running where it is
deployed while the model call goes to `GEMINI_LOCATION` (default `global`).

With a Gemini API key instead of Vertex, the plain model id is enough.
"""
from __future__ import annotations

import os
from functools import cached_property

from google.adk.models import Gemini
from google.genai import Client

from .. import config


def using_vertex() -> bool:
    flag = os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").strip().lower()
    if flag in ("true", "1", "yes"):
        return True
    if flag in ("false", "0", "no"):
        return False
    return not os.environ.get("GOOGLE_API_KEY")


class GlobalGemini(Gemini):
    """ADK Gemini model whose Vertex client is pinned to GEMINI_LOCATION."""

    @cached_property
    def api_client(self) -> Client:
        kwargs = dict(vertexai=True, location=config.GEMINI_LOCATION)
        if config.GOOGLE_CLOUD_PROJECT:
            kwargs["project"] = config.GOOGLE_CLOUD_PROJECT
        return Client(**kwargs)


def model_spec(model: str | None = None):
    """What to pass as `model=` to an LlmAgent."""
    name = model or config.GEMINI_MODEL
    return GlobalGemini(model=name) if using_vertex() else name
