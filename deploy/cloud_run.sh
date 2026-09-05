#!/usr/bin/env bash
# One-shot deploy. Requires: gcloud, a project with billing, Grafana Cloud credentials in .env.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT_ID:?set PROJECT_ID}"; REGION="${REGION:-us-central1}"
set -a; source .env; set +a
export PROJECT_ID REGION GEMINI_MODEL GRAFANA_URL OTLP_METRICS_ENDPOINT OTLP_LOGS_ENDPOINT PROMETHEUS_DATASOURCE LOKI_DATASOURCE

gcloud services enable run.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com --project "$PROJECT_ID"

# least-privilege runtime identity
SA="backlot-runner@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud iam service-accounts create backlot-runner --display-name "Backlot runtime" --project "$PROJECT_ID"
for role in roles/aiplatform.user roles/secretmanager.secretAccessor roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" --quiet >/dev/null
done

# secrets (idempotent)
for s in grafana-sa-token:GRAFANA_SERVICE_ACCOUNT_TOKEN mcp-grafana-server-token:MCP_GRAFANA_SERVER_TOKEN otlp-auth-header:OTLP_AUTH_HEADER; do
  name="${s%%:*}"; var="${s##*:}"
  gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1 || gcloud secrets create "$name" --replication-policy automatic --project "$PROJECT_ID"
  printf '%s' "${!var}" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT_ID" >/dev/null
done

gcloud artifacts repositories describe backlot --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud artifacts repositories create backlot --repository-format docker --location "$REGION" --project "$PROJECT_ID"
gcloud builds submit --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/backlot/backlot:latest" --project "$PROJECT_ID"

envsubst < deploy/cloud_run.yaml | gcloud run services replace - --region "$REGION" --project "$PROJECT_ID"
gcloud run services add-iam-policy-binding backlot --region "$REGION" --project "$PROJECT_ID" \
  --member allUsers --role roles/run.invoker --quiet >/dev/null
gcloud run services describe backlot --region "$REGION" --project "$PROJECT_ID" --format 'value(status.url)'
