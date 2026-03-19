#!/usr/bin/env bash
# Deploy the latest image to Cloud Run using env vars from .env.
# All server runtime variables from .env are pushed to Cloud Run (except VITE_*, EVAL_*, PORT).
# Run from repo root: ./scripts/gcp-deploy.sh

set -e
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.template to .env and set required variables."
  exit 1
fi

read_var() {
  grep -E "^${1}=" .env | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | head -1
}

# Grep all variable names from .env (KEY=value), exclude build-time / local-only
env_keys() {
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env | cut -d= -f1 | while read -r k; do
    [[ "$k" =~ ^VITE_ ]] && continue   # client build-time
    [[ "$k" =~ ^EVAL_ ]] && continue   # local evals
    [[ "$k" == PORT ]] && continue     # Cloud Run sets PORT
    echo "$k"
  done
}

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [[ -z "$PROJECT_ID" ]]; then
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

IMAGE="${IMAGE:-us-central1-docker.pkg.dev/${PROJECT_ID}/portfolio-agent/agent:latest}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-portfolio-agent}"

# Required for Cloud Run — must be set in .env
REQUIRED_VARS=(ANTHROPIC_API_KEY SUPABASE_URL SUPABASE_ANON_KEY DATABASE_URL DIRECT_URL ENCRYPTION_KEY ENCRYPTION_SALT)
missing=()
for v in "${REQUIRED_VARS[@]}"; do
  val=$(read_var "$v")
  if [[ -z "$val" ]]; then
    missing+=("$v")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Set in .env: ${missing[*]}"
  exit 1
fi

# CORS_ORIGIN default if unset
CORS_ORIGIN=$(read_var CORS_ORIGIN)
if [[ -z "$CORS_ORIGIN" ]]; then
  CORS_ORIGIN="http://localhost:5179"
  echo "CORS_ORIGIN not in .env, using $CORS_ORIGIN — set to your Cloud Run URL after deploy."
fi

# Build env file from .env: every key from .env (except excluded) gets pushed to Cloud Run
ENV_FILE=$(mktemp)
trap "rm -f $ENV_FILE" EXIT
while IFS= read -r key; do
  [[ -z "$key" ]] && continue
  val=$(read_var "$key")
  # Use CORS_ORIGIN default when key is CORS_ORIGIN and empty
  if [[ "$key" == CORS_ORIGIN && -z "$val" ]]; then
    val="$CORS_ORIGIN"
  fi
  # Server expects STRIPE_PRICE_ID_PRO; .env may have STRIPE_PRO_PRICE_ID
  if [[ "$key" == STRIPE_PRO_PRICE_ID ]]; then
    key=STRIPE_PRICE_ID_PRO
  fi
  if [[ -n "$val" ]]; then
    escaped=$(echo "$val" | sed 's/"/\\"/g')
    echo "${key}: \"${escaped}\"" >> "$ENV_FILE"
  fi
done < <(env_keys)

# If no vars (e.g. .env only had exclusions), ensure required are present
if [[ ! -s "$ENV_FILE" ]]; then
  echo "No env vars found in .env for Cloud Run. Check .env has KEY=value lines (excluding VITE_*, EVAL_*, PORT)."
  exit 1
fi

# Ensure CORS_ORIGIN is always set on Cloud Run (default if missing from .env)
if ! grep -q '^CORS_ORIGIN:' "$ENV_FILE" 2>/dev/null; then
  echo "CORS_ORIGIN: \"$CORS_ORIGIN\"" >> "$ENV_FILE"
fi

echo "Deploying to Cloud Run (project=$PROJECT_ID, image=$IMAGE)..."
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --env-vars-file "$ENV_FILE"

echo ""
echo "Done. Service URL:"
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format 'value(status.url)'
echo ""
echo "If this was the first deploy, set CORS_ORIGIN in Cloud Run to the URL above (Variables & secrets)."
echo "Then run migrations once: npx prisma migrate deploy (using same DATABASE_URL/DIRECT_URL as Cloud Run)."
