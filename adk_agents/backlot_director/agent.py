"""ADK CLI entry point:  adk web adk_agents  |  adk run adk_agents/backlot_director

Deploy to Agent Engine (Gemini Enterprise Agent Platform):
  adk deploy agent_engine --project $PROJECT_ID --region $REGION \
      --staging_bucket gs://$BUCKET --display_name "Backlot Production Director" adk_agents/backlot_director
"""
from backlot.agents.front_desk import build_front_desk

root_agent = build_front_desk()
