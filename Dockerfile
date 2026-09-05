FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY pyproject.toml README.md LICENSE ./
COPY backlot ./backlot
COPY grafana ./grafana
COPY scripts ./scripts
COPY adk_agents ./adk_agents
RUN pip install --no-cache-dir . "mcp<2"
ENV PORT=8080 BACKLOT_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["sh", "-c", "uvicorn backlot.web.app:app --host 0.0.0.0 --port ${PORT}"]
