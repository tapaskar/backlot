# ADK agents

`backlot_director/` exposes Backlot's front desk, the *Backlot Production Director*, in the layout the
ADK command line expects (`agent.py` with a `root_agent`). It imports the same code the web app uses
(`backlot/agents/front_desk.py`); nothing is duplicated.

```bash
pip install -e ".[test]" "mcp<2"
export GOOGLE_GENAI_USE_VERTEXAI=TRUE GOOGLE_CLOUD_PROJECT=... GOOGLE_CLOUD_LOCATION=us-central1
adk web adk_agents                       # chat UI with traces at http://localhost:8000
adk run adk_agents/backlot_director      # terminal chat
adk deploy agent_engine --project $PROJECT_ID --region $REGION --staging_bucket gs://$BUCKET \
    --display_name "Backlot Production Director" adk_agents/backlot_director
```

Gemini 3.x on Vertex is served from the `global` location; `GlobalGemini` in
`backlot/agents/models.py` pins the model client there while the agent runs in your region.
