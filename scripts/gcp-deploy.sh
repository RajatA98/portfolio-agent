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

# Optional env vars — only included if set in .env
STRIPE_SECRET_KEY=$(read_var STRIPE_SECRET_KEY)
STRIPE_WEBHOOK_SECRET=$(read_var STRIPE_WEBHOOK_SECRET)
STRIPE_PRICE_ID_PRO=$(read_var STRIPE_PRICE_ID_PRO)
SNAPTRADE_CLIENT_ID=$(read_var SNAPTRADE_CLIENT_ID)
SNAPTRADE_CONSUMER_KEY=$(read_var SNAPTRADE_CONSUMER_KEY)
SUPABASE_SERVICE_ROLE_KEY=$(read_var SUPABASE_SERVICE_ROLE_KEY)
FREE_TIER_DAILY_TOKEN_LIMIT=$(read_var FREE_TIER_DAILY_TOKEN_LIMIT)

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

# Append optional env vars only if set
add_optional_var() {
  local name="$1" value="$2"
  if [[ -n "$value" ]]; then
    echo "${name}: \"$(echo "$value" | sed 's/"/\\"/g')\"" >> "$ENV_FILE"
  fi
}

add_optional_var STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY"
add_optional_var STRIPE_WEBHOOK_SECRET "$STRIPE_WEBHOOK_SECRET"
add_optional_var STRIPE_PRICE_ID_PRO "$STRIPE_PRICE_ID_PRO"
add_optional_var SNAPTRADE_CLIENT_ID "$SNAPTRADE_CLIENT_ID"
add_optional_var SNAPTRADE_CONSUMER_KEY "$SNAPTRADE_CONSUMER_KEY"
add_optional_var SUPABASE_SERVICE_ROLE_KEY "$SUPABASE_SERVICE_ROLE_KEY"
add_optional_var FREE_TIER_DAILY_TOKEN_LIMIT "$FREE_TIER_DAILY_TOKEN_LIMIT"

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
