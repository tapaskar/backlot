"""Grafana HTTP API calls made by *code* at greenlight time: create the
production dashboard and resolve datasource UIDs. Everything the agents do at
runtime goes through the Grafana MCP server instead (see agents/grafana_mcp.py);
this module exists so a project has a dashboard before the first day is shot.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from . import config

TEMPLATE = Path(__file__).resolve().parent.parent / "grafana" / "dashboard.json"


def _client() -> httpx.Client:
    if not config.GRAFANA_SERVICE_ACCOUNT_TOKEN:
        raise RuntimeError("GRAFANA_SERVICE_ACCOUNT_TOKEN is not set")
    return httpx.Client(base_url=config.GRAFANA_URL.rstrip("/"), timeout=20,
                        headers={"Authorization": f"Bearer {config.GRAFANA_SERVICE_ACCOUNT_TOKEN}"})


def datasource_uids() -> dict[str, str]:
    """Map 'prometheus' / 'loki' to the UIDs of the datasources named in config."""
    with _client() as c:
        r = c.get("/api/datasources"); r.raise_for_status()
        ds = r.json()
    out = {}
    for kind, wanted in (("prometheus", config.PROMETHEUS_DATASOURCE), ("loki", config.LOKI_DATASOURCE)):
        match = [d for d in ds if d.get("name") == wanted] or [d for d in ds if d.get("type") == kind]
        if match:
            out[kind] = match[0]["uid"]
    return out


def render_dashboard(slug: str, title: str, uids: dict[str, str]) -> dict:
    txt = TEMPLATE.read_text()
    for k, v in {"__SLUG__": slug, "__TITLE__": title.replace('"', "'"),
                 "__PROM__": uids.get("prometheus", ""), "__LOKI__": uids.get("loki", "")}.items():
        txt = txt.replace(k, v)
    return json.loads(txt)


def create_dashboard(slug: str, title: str) -> dict:
    """Create or overwrite the project's dashboard. Returns {'url':..., 'uid':...}."""
    uids = datasource_uids()
    dash = render_dashboard(slug, title, uids)
    with _client() as c:
        r = c.post("/api/dashboards/db", json={"dashboard": dash, "overwrite": True,
                                               "message": "Backlot greenlight"})
        r.raise_for_status()
        body = r.json()
    return {"uid": body.get("uid"), "url": config.GRAFANA_URL.rstrip("/") + body.get("url", ""),
            "datasources": uids}


def annotate(slug: str, text: str, tags: list[str] | None = None) -> dict:
    """Fallback annotation writer used only when the MCP server is unavailable."""
    with _client() as c:
        r = c.post("/api/annotations", json={"tags": ["backlot", slug, *(tags or [])], "text": text})
        r.raise_for_status()
        return r.json()
