#!/usr/bin/env bash
# Grant the Cloud Build service account permission to fetch the repo via Developer Connect.
# Fixes: "Permission 'developerconnect.gitRepositoryLinks.fetchReadToken' denied"
# Run once: ./scripts/gcp-fix-developer-connect-iam.sh

set -e
cd "$(dirname "$0")/.."

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [[ -z "$PROJECT_ID" ]]; then
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
ROLE="roles/developerconnect.readTokenAccessor"

echo "Project: $PROJECT_ID (number: $PROJECT_NUMBER)"
echo "Granting $ROLE to Cloud Build SA: $BUILD_SA"
# Use an always-true condition so the binding is effectively unconditional (required when project has other conditional bindings)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" \
  --role="$ROLE" \
  --condition='expression=request.time >= timestamp("1970-01-01T00:00:00Z"),title=always'

echo "Done. Re-run your Cloud Run build (e.g. push a commit or trigger a new deployment)."
