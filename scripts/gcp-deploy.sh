#!/usr/bin/env bash
# Deploy the latest image to Cloud Run using env vars from .env.
# Run from repo root: ./scripts/gcp-deploy.sh
# First deploy will use CORS_ORIGIN from .env; update it in Cloud Run console to the service URL after deploy.

set -e
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.template to .env and set required variables."
  exit 1
fi

read_var() {
  grep -E "^${1}=" .env | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | head -1
}

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [[ -z "$PROJECT_ID" ]]; then
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

IMAGE="${IMAGE:-us-central1-docker.pkg.dev/${PROJECT_ID}/portfolio-agent/agent:latest}"
REGION="${REGION:-us-central1}"

# Required for Cloud Run
ANTHROPIC_API_KEY=$(read_var ANTHROPIC_API_KEY)
SUPABASE_URL=$(read_var SUPABASE_URL)
SUPABASE_ANON_KEY=$(read_var SUPABASE_ANON_KEY)
DATABASE_URL=$(read_var DATABASE_URL)
DIRECT_URL=$(read_var DIRECT_URL)
ENCRYPTION_KEY=$(read_var ENCRYPTION_KEY)
ENCRYPTION_SALT=$(read_var ENCRYPTION_SALT)
CORS_ORIGIN=$(read_var CORS_ORIGIN)

if [[ -z "$ANTHROPIC_API_KEY" || -z "$SUPABASE_URL" || -z "$SUPABASE_ANON_KEY" || -z "$DATABASE_URL" || -z "$DIRECT_URL" || -z "$ENCRYPTION_KEY" || -z "$ENCRYPTION_SALT" ]]; then
  echo "Set in .env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, DATABASE_URL, DIRECT_URL, ENCRYPTION_KEY, ENCRYPTION_SALT"
  exit 1
fi

# CORS_ORIGIN: use from .env or placeholder; update in console after first deploy to service URL
if [[ -z "$CORS_ORIGIN" ]]; then
  CORS_ORIGIN="http://localhost:5179"
  echo "CORS_ORIGIN not in .env, using $CORS_ORIGIN — set to your Cloud Run URL in console after deploy."
fi

ENV_FILE=$(mktemp)
trap "rm -f $ENV_FILE" EXIT
cat > "$ENV_FILE" << EOF
ANTHROPIC_API_KEY: "$(echo "$ANTHROPIC_API_KEY" | sed 's/"/\\"/g')"
SUPABASE_URL: "$(echo "$SUPABASE_URL" | sed 's/"/\\"/g')"
SUPABASE_ANON_KEY: "$(echo "$SUPABASE_ANON_KEY" | sed 's/"/\\"/g')"
DATABASE_URL: "$(echo "$DATABASE_URL" | sed 's/"/\\"/g')"
DIRECT_URL: "$(echo "$DIRECT_URL" | sed 's/"/\\"/g')"
ENCRYPTION_KEY: "$(echo "$ENCRYPTION_KEY" | sed 's/"/\\"/g')"
ENCRYPTION_SALT: "$(echo "$ENCRYPTION_SALT" | sed 's/"/\\"/g')"
CORS_ORIGIN: "$(echo "$CORS_ORIGIN" | sed 's/"/\\"/g')"
EOF

echo "Deploying to Cloud Run (project=$PROJECT_ID, image=$IMAGE)..."
gcloud run deploy portfolio-agent \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --env-vars-file "$ENV_FILE"

echo ""
echo "Done. Service URL:"
gcloud run services describe portfolio-agent --region "$REGION" --format 'value(status.url)'
echo ""
echo "If this was the first deploy, set CORS_ORIGIN in Cloud Run to the URL above (Variables & secrets)."
echo "Then run migrations once: npx prisma migrate deploy (using same DATABASE_URL/DIRECT_URL as Cloud Run)."
