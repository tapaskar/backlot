# Backlot

**An AI production office for independent filmmakers.** Paste a screenplay. Backlot breaks it
down, schedules the shoot, budgets it, puts the whole production on a Grafana dashboard, and then
runs the shoot day by day: a director agent reads the day's numbers from Grafana, decides what
changes tomorrow, re-packs the schedule, and writes its decision back to the dashboard.

Built for the *Agentic Cinema: The Blockbuster Hackathon*, **Grafana Labs track**: a
deterministic multi-agent system on Gemini and the Gemini Enterprise Agent Platform (Agent
Development Kit), integrated with the **Grafana MCP server** at runtime for both reads and writes.
A conversational **front desk**, the Backlot Production Director, sits in front of it: ask for a
script, a shot list, AI-video prompts or pipeline docs, then send the script into the pipeline.

```
idea ──▶ front desk (director ▸ screenwriter / prompt engineer / docs, + search) ──▶ script
                                                                                   │
script ──▶ breakdown ──▶ schedule ──▶ budget ──▶ Grafana dashboard ◀───────────────┘
                                                       │
            shoot day N ──▶ telemetry ──▶ Grafana ◀────┘
                                │
                  set_investigator (MCP reads) ──▶ director (decides) ──▶ scribe (MCP annotation)
                                │
                        replan remaining days ──▶ ... ──▶ wrap report
```

## Who it is for

Small crews without a production office: student films, shorts, micro-budget features. The
bottleneck it removes is the one that sinks these shoots: nobody is watching pages-per-day and
spend while the day is happening, so slips are discovered on the last day. Backlot gives a
three-person crew the control room a studio has.

## The agents

| Agent | Type | Output | Reads | Writes |
|---|---|---|---|---|
| `script_supervisor` | LlmAgent, `output_schema=Breakdown` | enriched breakdown: props, hazards, synopses | script + deterministic parse | |
| `line_producer` | LlmAgent, `output_schema=ProducerNotes` | ranked risks and cheap fixes | schedule + budget | |
| `set_investigator` | LlmAgent + **Grafana MCP** (read tools) | numbered facts with numbers | `query_prometheus`, `query_loki_logs`, `search_dashboards`, `generate_deeplink` | |
| `director` | LlmAgent, `output_schema=DirectorNote` | status, decision, replan, scenes to push | investigator's evidence + remaining plan | |
| `scribe` | LlmAgent + **Grafana MCP** (write tool) | annotation id | | `create_annotation` on the dashboard |
| `wrap_investigator` / `wrap_writer` | LlmAgent + MCP / `output_schema=WrapReport` | wrap report | whole production from Grafana | |

### The front desk

`backlot/agents/front_desk.py` is the Agent Studio export, cleaned up and wired in. A coordinator,
`backlot_production_director`, delegates to three specialists and can research on its own:

| Agent | Job | Tools |
|---|---|---|
| `screenplay_agent` | scripts, scene outlines, arcs, written in Fountain form so they schedule without editing | |
| `prompt_pipeline_agent` | shot lists, AI-video generation prompts, pipeline steps and Grafana metric specs that reuse Backlot's telemetry contract | Google Search, URL context (each on its own agent, wrapped as an AgentTool) |
| `doc_code_specialist` | code, scripts, READMEs for the crew's repository | |
| coordinator | routes, answers short questions, researches | Google Search, URL context |

It is reachable three ways: the chat panel in the app (`POST /api/chat`, or per project
`POST /api/projects/{slug}/chat`, sessions persist per project), the ADK dev UI (`adk web adk_agents`),
and Agent Engine (`adk deploy agent_engine ... adk_agents/backlot_director`, see `adk_agents/README.md`).
"Use reply as script" drops a generated screenplay into the breakdown.

**Gemini 3.x and the `global` location.** On Vertex AI these models are only served from `global`,
while an Agent Engine or Cloud Run instance lives in a region, so the stock client fails with
model-not-found. `GlobalGemini` (`backlot/agents/models.py`) overrides the ADK model's client to
`GEMINI_LOCATION` (default `global`) and every agent in the repo, crew and front desk alike, is built
through `model_spec()`, which uses it on Vertex and the plain model id with an API key.

### The crew

`end_of_day = SequentialAgent(investigator → director → scribe)` and `wrap_up` are fixed
sequences: no delegation, no loops, the same three steps every day, each step's typed output in
session state for the next. The scheduler and the budget are plain code, so the agents reason
*about* the plan and never invent it; the director's `move_scenes` goes through the same packer.

**Why Grafana is load-bearing, not decorative.** The director never sees the simulator's return
value. It only knows what the investigator read from Grafana through MCP, so the dashboard the
crew sees and the evidence the agent used are the same numbers. The decision is then posted back
as an annotation, so the dashboard carries the human-readable why alongside the metrics.

## Quick start

### Option A: the compose studio (Grafana, Prometheus, Loki, MCP server, Backlot)

```bash
cp .env.example .env            # set GEMINI_MODEL, GOOGLE_CLOUD_PROJECT (+ gcloud auth) or GOOGLE_API_KEY
docker compose up -d grafana    # then create a service account token in Grafana (admin / backlot):
                                #   Administration → Service accounts → Add → role Editor → token
                                # put it in .env as GRAFANA_SERVICE_ACCOUNT_TOKEN
docker compose up --build       # Backlot on http://localhost:8080, Grafana on http://localhost:3000
python scripts/demo.py --chaos 0.5
```

### Option B: Grafana Cloud + local app

Create a free Grafana Cloud stack. In `.env` set `GRAFANA_URL`, a service-account token (Editor),
the OTLP gateway endpoints and the Basic auth header from *Connections → OpenTelemetry*, and the
names of the stack's Prometheus and Loki datasources. Run the MCP server locally
(`go install github.com/grafana/mcp-grafana/cmd/mcp-grafana@latest`, leave `MCP_GRAFANA_URL` unset
so Backlot launches it over stdio), then `scripts/run_local.sh`.

### Option C: Cloud Run (what the judges' URL runs)

`deploy/cloud_run.sh` builds the image, creates a least-privilege service account, stores the
three secrets in Secret Manager, and deploys Backlot with the Grafana MCP server as a sidecar.

### No credentials at all

`BACKLOT_OFFLINE=1` swaps every Gemini step for a rule-based stand-in with the same typed output,
so the UI, the API and the tests run end to end. Offline results are marked `(offline)`.

## Governance

- **Agent identity.** Cloud Run runs as `backlot-runner`, holding only `aiplatform.user`,
  `secretmanager.secretAccessor` and `logging.logWriter`.
- **Least privilege on Grafana.** One service-account token, Editor role, scoped by tool filters:
  the investigator can only read metrics and logs and generate links; the scribe can only create
  annotations. Admin and OnCall tool categories are disabled at the MCP server (`--disable-admin
  --disable-oncall`). No prompt can reach dashboards' settings, users or alert routing.
- **Caller auth on the MCP server.** The sidecar listens on localhost with
  `MCP_GRAFANA_SERVER_TOKEN`; the app presents it as a bearer token.
- **Determinism where it matters.** Scheduling, budgeting and replanning are pure functions with
  tests; the LLM steps return Pydantic models validated before use, and the breakdown agent's
  output is checked against the parse so it cannot add, drop or resize scenes.
- **Auditability.** Every decision is an annotation on the dashboard with tags
  `backlot, <project>, day-N, <status>`; every tool call is logged with the agent name.

## Telemetry

Pushed over OTLP/HTTP (Grafana Cloud gateway, or Prometheus 3 and Loki 3 locally):

| Metric | Meaning |
|---|---|
| `backlot_scenes_total`, `backlot_scenes_completed` | progress |
| `backlot_eighths_planned_today`, `backlot_eighths_completed_today` | today's pages, the slip signal |
| `backlot_delay_minutes{cause}` | minutes lost to weather, cast, camera, sound, access |
| `backlot_budget_planned_usd`, `backlot_budget_spent_usd` | spend vs plan |
| `backlot_takes_total`, `backlot_setups_total`, `backlot_day`, `backlot_days_planned` | pace |

Logs: one line per production event (`call`, `hold`, `take`, `complete`, `push`, `wrap`,
`replan`) with `project`, `day`, `kind`, `scene` attributes. The dashboard template is
`grafana/dashboard.json`, created per project at greenlight.

## Tests

```bash
pip install -e ".[test]" "mcp<2"
pytest -q          # 14 tests: parser, scheduler, replan, budget, simulator, front-desk tree,
                   # model routing, full API run offline, chat refused offline with a reason
```

## Layout

```
backlot/
  fountain.py       screenplay parser (deterministic)
  scheduling.py     day packer + replan (deterministic)
  budget.py         rate-card budget (deterministic)
  simulate.py       shooting-day simulator with seeded chaos
  telemetry.py      OTLP push + in-memory store
  grafana_provision.py  dashboard creation at greenlight (HTTP API)
  agents/crew.py    the seven pipeline agents and the two sequences
  agents/front_desk.py  the Production Director network (Agent Studio export, cleaned up)
  agents/models.py  GlobalGemini: pins Vertex model calls to the global location; model_spec()
  agents/chat.py    multi-turn sessions with the front desk
  agents/grafana_mcp.py  Grafana MCP toolset (streamable-http or stdio), tool filters
  agents/runtime.py run one agent with prepared state
  pipeline.py       greenlight / shoot_day / wrap
  web/app.py        FastAPI + single-page UI
adk_agents/backlot_director/  ADK CLI + Agent Engine entry point for the front desk
grafana/dashboard.json    docker-compose.yaml    deploy/cloud_run.{yaml,sh}    scripts/demo.py
```

## Honest limits

The shooting day is simulated. Real telemetry would come from the 1st AD's app, a slate app or
a timecode log; the metric names are the contract, the simulator is a stand-in. The rate card is
a micro-budget placeholder. The model is `GEMINI_MODEL` (default `gemini-3.5-flash`, served from
`GEMINI_LOCATION=global` on Vertex); set it to any Gemini Flash id your project can use. The front
desk's Google Search and URL context tools are Gemini built-ins and need Vertex AI or a Gemini API key
with grounding enabled.

## Licence

MIT. Uses the Grafana MCP server (Apache-2.0) and Google's Agent Development Kit (Apache-2.0).
