"""Backlot web app: a producer's desk in one page, plus a JSON API for judges and scripts."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__, config, pipeline
from ..agents import chat
from ..agents.grafana_mcp import grafana_configured
from ..fountain import parse_script
from ..store import store

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
app = FastAPI(title="Backlot", version=__version__)
STATIC = Path(__file__).resolve().parent / "static"
DEMO = Path(__file__).resolve().parent.parent.parent / "scripts" / "demo_script.fountain"


class NewProject(BaseModel):
    title: str | None = None
    script: str


class ShootRequest(BaseModel):
    chaos: float = 0.3
    seed: int = 0


class ChatRequest(BaseModel):
    message: str


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "model": config.GEMINI_MODEL,
            "offline": pipeline.offline(), "grafana": grafana_configured(),
            "grafana_url": config.GRAFANA_URL if config.GRAFANA_SERVICE_ACCOUNT_TOKEN else None}


@app.get("/api/demo-script")
def demo_script():
    return {"title": "THE LAST FERRY", "script": DEMO.read_text()}


@app.get("/api/projects")
def list_projects():
    return store.list()


@app.post("/api/projects", status_code=201)
def create_project(body: NewProject):
    parsed = parse_script(body.script, body.title)
    if not parsed.scenes:
        raise HTTPException(400, "No scene headings found (INT./EXT. ...)")
    p = store.create(body.title or parsed.title, body.script)
    p.breakdown = parsed
    store.save(p)
    return p


@app.get("/api/projects/{slug}")
def get_project(slug: str):
    p = store.get(slug)
    if not p:
        raise HTTPException(404, "no such project")
    return p


@app.post("/api/projects/{slug}/greenlight")
async def greenlight(slug: str, eighths_per_day: int = 40):
    p = store.get(slug)
    if not p:
        raise HTTPException(404, "no such project")
    return await pipeline.greenlight(p, eighths_per_day)


@app.post("/api/projects/{slug}/shoot")
async def shoot(slug: str, body: ShootRequest | None = None):
    p = store.get(slug)
    if not p:
        raise HTTPException(404, "no such project")
    body = body or ShootRequest()
    try:
        return await pipeline.shoot_day(p, chaos=body.chaos, seed=body.seed)
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/api/projects/{slug}/wrap")
async def wrap(slug: str):
    p = store.get(slug)
    if not p:
        raise HTTPException(404, "no such project")
    try:
        return await pipeline.wrap(p)
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/api/chat")
async def chat_lobby(body: ChatRequest):
    """Talk to the Backlot Production Director before a project exists."""
    return await _chat("lobby", body.message)


@app.post("/api/projects/{slug}/chat")
async def chat_project(slug: str, body: ChatRequest):
    """Talk to the director about this project; the session persists per project."""
    if not store.get(slug):
        raise HTTPException(404, "no such project")
    return await _chat(slug, body.message)


async def _chat(session_id: str, message: str):
    if pipeline.offline():
        raise HTTPException(503, "The front desk needs Gemini credentials (GOOGLE_API_KEY or "
                                 "GOOGLE_GENAI_USE_VERTEXAI=TRUE with GOOGLE_CLOUD_PROJECT); offline mode "
                                 "only runs the deterministic pipeline.")
    if not message.strip():
        raise HTTPException(400, "empty message")
    return await chat.ask(session_id, message.strip())


@app.exception_handler(Exception)
async def unhandled(_, exc: Exception):
    logging.getLogger("backlot.web").exception("request failed")
    return JSONResponse(status_code=500, content={"error": str(exc)})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
