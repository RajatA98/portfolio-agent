# Deploy Portfolio Agent to GCP Cloud Run

Step-by-step guide to build, push, and run the app on Google Cloud Run.

## 1. Prerequisites

- [Google Cloud SDK (gcloud)](https://cloud.google.com/sdk/docs/install) installed and logged in: `gcloud auth login`
- A GCP project. Set it:
  ```bash
  export PROJECT_ID=your-gcp-project-id
  gcloud config set project $PROJECT_ID
  ```
- Billing enabled on the project (Cloud Run and Artifact Registry require it).

## 2. One-time setup: enable APIs and Artifact Registry

```bash
# Enable required APIs
gcloud services enable cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com

# Create Artifact Registry repo for Docker images (region must match cloudbuild.yaml)
gcloud artifacts repositories create portfolio-agent \
  --repository-format=docker \
  --location=us-central1 \
  --description="Portfolio Agent Docker images"
```

If the repo already exists, you can skip the `create` command.

## 3. Gather required values

Before building, you need:

| Variable | Where to get it |
|----------|-----------------|
| `VITE_SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → anon public key |
| `DATABASE_URL` | Supabase Dashboard → Project Settings → Database → Connection string (URI, "Transaction" pooler) |
| `DIRECT_URL` | Same → Connection string (URI, "Session" / direct) |
| `ENCRYPTION_KEY` | Generate: `openssl rand -hex 32` |
| `ENCRYPTION_SALT` | Generate: `openssl rand -hex 16` |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/) |

After deploy you’ll set `CORS_ORIGIN` to your Cloud Run URL (e.g. `https://portfolio-agent-xxxxx.run.app`).

## 4. Build and push the image

From the repo root (where `cloudbuild.yaml` lives):

```bash
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co,_VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

Replace `YOUR_PROJECT` and `YOUR_ANON_KEY` with your Supabase values. The build runs in the cloud and pushes the image to `us-central1-docker.pkg.dev/$PROJECT_ID/portfolio-agent/agent:latest`.

## 5. Deploy to Cloud Run

```bash
gcloud run deploy portfolio-agent \
  --image us-central1-docker.pkg.dev/$PROJECT_ID/portfolio-agent/agent:latest \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "ANTHROPIC_API_KEY=your_key,SUPABASE_URL=https://YOUR_PROJECT.supabase.co,SUPABASE_ANON_KEY=YOUR_ANON_KEY,DATABASE_URL=postgresql://...,DIRECT_URL=postgresql://...,ENCRYPTION_KEY=...,ENCRYPTION_SALT=...,CORS_ORIGIN=https://portfolio-agent-XXXX.run.app"
```

- Replace all placeholders with your real values.
- For many variables, it’s easier to use the Cloud Console after the first deploy: **Cloud Run → portfolio-agent → Edit & deploy new revision → Variables & secrets**.
- On first deploy, you can set `CORS_ORIGIN=http://localhost:5179` then change it to the Cloud Run URL once you see the service URL.

After deploy, note the service URL (e.g. `https://portfolio-agent-xxxxx-uc.a.run.app`).

## 6. Set CORS_ORIGIN and optional env vars

1. Open [Cloud Run](https://console.cloud.google.com/run), click **portfolio-agent**.
2. **Edit & deploy new revision** → **Variables & secrets**.
3. Set `CORS_ORIGIN` to your Cloud Run URL (e.g. `https://portfolio-agent-xxxxx-uc.a.run.app`) so the browser can call the API.
4. Add any optional vars: `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`, `AGENT_ENABLE_MARKET`, `SUPABASE_SERVICE_ROLE_KEY`, etc. (see `.env.template`).

## 7. Run database migrations

Use the same `DATABASE_URL` and `DIRECT_URL` as in Cloud Run (e.g. from your local `.env` or a one-off Cloud Run job):

```bash
npx prisma migrate deploy
```

Run this once per production database, or whenever you add new migrations.

## 8. Open the app

Visit the Cloud Run service URL. The server serves the built frontend; sign in with Supabase and (optionally) connect a brokerage via SnapTrade.

---

## Optional: Cloud Build trigger from GitHub

To build and push on every push to `main`:

1. **Cloud Build → Triggers → Create trigger**.
2. Connect your GitHub repo (first-time: link GitHub, authorize).
3. **Event**: Push to a branch; branch `^main$`.
4. **Configuration**: Cloud Build configuration file; path `cloudbuild.yaml`.
5. **Substitution variables**: Add `_VITE_SUPABASE_URL` and `_VITE_SUPABASE_ANON_KEY` (and optionally `_REGION`, `_REPO`, `_IMAGE`).
6. Save. On push to `main`, Cloud Build runs and pushes the image; you still deploy (or use a second trigger / Cloud Run continuous deploy if configured).

## Optional: Deploy latest image after build

To deploy the new image automatically after a successful build, add a deploy step to `cloudbuild.yaml` or use a second trigger that runs `gcloud run deploy` with the new image. For manual control, run the deploy command from step 5 whenever you want to roll out a new revision.
