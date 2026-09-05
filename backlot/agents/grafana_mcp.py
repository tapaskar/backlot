"""The Grafana MCP server as an ADK toolset.

Two transports, chosen by configuration:
  * streamable-http  - the mcp-grafana container next to the app (docker compose
                       locally, a sidecar on Cloud Run), optionally with caller auth;
  * stdio            - the mcp-grafana binary launched by the agent process.

Tool filters are deliberately narrow: the director reads metrics and logs and
writes annotations; nothing else on the Grafana instance is reachable from a
prompt. The service-account token behind the server is scoped the same way.
"""
from __future__ import annotations

from google.adk.tools.mcp_tool.mcp_session_manager import (StdioConnectionParams,
                                                          StreamableHTTPConnectionParams)
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from mcp import StdioServerParameters

from .. import config

READ_TOOLS = ["list_datasources", "query_prometheus", "query_loki_logs", "list_loki_label_values",
              "search_dashboards", "generate_deeplink"]
WRITE_TOOLS = ["create_annotation"]


def grafana_toolset(tool_filter: list[str] | None = None) -> McpToolset:
    if config.MCP_GRAFANA_URL:
        headers = ({"Authorization": f"Bearer {config.MCP_GRAFANA_SERVER_TOKEN}"}
                   if config.MCP_GRAFANA_SERVER_TOKEN else None)
        params = StreamableHTTPConnectionParams(url=config.MCP_GRAFANA_URL, headers=headers, timeout=30)
    else:
        params = StdioConnectionParams(server_params=StdioServerParameters(
            command=config.MCP_GRAFANA_COMMAND, args=["-t", "stdio", "--disable-admin", "--disable-oncall"],
            env={"GRAFANA_URL": config.GRAFANA_URL or "",
                 "GRAFANA_SERVICE_ACCOUNT_TOKEN": config.GRAFANA_SERVICE_ACCOUNT_TOKEN or ""}), timeout=30)
    return McpToolset(connection_params=params, tool_filter=tool_filter or READ_TOOLS)


def grafana_configured() -> bool:
    return bool(config.GRAFANA_SERVICE_ACCOUNT_TOKEN and (config.MCP_GRAFANA_URL or config.MCP_GRAFANA_COMMAND))
