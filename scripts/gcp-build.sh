#!/usr/bin/env bash
# Build and push Docker image to GCP Artifact Registry using values from .env.
# Run from repo root: ./scripts/gcp-build.sh

set -e
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.template to .env and set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  exit 1
fi

# Read from .env (strip quotes and comments)
read_var() {
  grep -E "^${1}=" .env | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | head -1
}

VITE_SUPABASE_URL=$(read_var VITE_SUPABASE_URL)
VITE_SUPABASE_ANON_KEY=$(read_var VITE_SUPABASE_ANON_KEY)

if [[ -z "$VITE_SUPABASE_URL" || -z "$VITE_SUPABASE_ANON_KEY" ]]; then
  echo "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env"
  exit 1
fi

echo "Using VITE_SUPABASE_URL from .env"
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions="_VITE_SUPABASE_URL=${VITE_SUPABASE_URL}" \
  --substitutions="_VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}"
