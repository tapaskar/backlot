"""All configuration comes from the environment; see .env.example."""
from __future__ import annotations

import os
from pathlib import Path


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


GEMINI_MODEL = env("GEMINI_MODEL", "gemini-3.8-flash")
DATA_DIR = Path(env("BACKLOT_DATA_DIR", "data"))

# Grafana instance the MCP server talks to (Grafana Cloud or local OSS)
GRAFANA_URL = env("GRAFANA_URL", "http://localhost:3000")
GRAFANA_SERVICE_ACCOUNT_TOKEN = env("GRAFANA_SERVICE_ACCOUNT_TOKEN")

# How the agents reach the Grafana MCP server:
#   MCP_GRAFANA_URL      streamable-http endpoint (Cloud Run sidecar / docker compose), or
#   MCP_GRAFANA_COMMAND  a local binary launched over stdio ("mcp-grafana")
MCP_GRAFANA_URL = env("MCP_GRAFANA_URL")
MCP_GRAFANA_COMMAND = env("MCP_GRAFANA_COMMAND", "mcp-grafana")
MCP_GRAFANA_SERVER_TOKEN = env("MCP_GRAFANA_SERVER_TOKEN")   # caller auth for the http transport

# Where production telemetry is pushed (OTLP/HTTP). Grafana Cloud exposes one
# gateway for both; local Prometheus 3 + Loki 3 expose one endpoint each.
OTLP_METRICS_ENDPOINT = env("OTLP_METRICS_ENDPOINT")
OTLP_LOGS_ENDPOINT = env("OTLP_LOGS_ENDPOINT")
OTLP_AUTH_HEADER = env("OTLP_AUTH_HEADER")   # e.g. "Basic <base64 instance:token>" for Grafana Cloud

# Datasource names the director looks for inside Grafana
PROMETHEUS_DATASOURCE = env("PROMETHEUS_DATASOURCE", "prometheus")
LOKI_DATASOURCE = env("LOKI_DATASOURCE", "loki")
