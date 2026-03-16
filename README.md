# Portfolio Agent

Standalone AI agent service and frontend for Ghostfolio.

## Requirements checklist

| Requirement | Status |
|-------------|--------|
| Agent responds to natural language queries (portfolio domain) | ✓ |
| At least 3 functional tools | ✓ (`getPortfolioSnapshot`, `getPerformance`, `simulateAllocationChange`; optional `getMarketPrices`) |
| Tool calls execute and return structured results | ✓ |
| Agent synthesizes tool results into coherent responses | ✓ |
| Conversation history maintained across turns | ✓ (client sends `conversationHistory` to API) |
| Basic error handling (graceful failure, not crashes) | ✓ |
| At least one domain-specific verification check | ✓ (advice boundary, allocation sum, cost-basis labeling in `agent.verifier`) |
| Simple evaluation: 5+ test cases with expected outcomes | ✓ (Jest: 5 unit tests; golden set cases in `golden_sets/*.eval.yaml`; scenario set in `scenario_sets/*.eval.yaml`) |
| Deployed and publicly accessible | Deploy via GCP Cloud Run, Docker, or VPS (see below) |

## What it does

- Exposes a chat API at `POST /api/chat`
- Uses Claude tool-calling
- Fetches portfolio data from Ghostfolio over HTTP using the user JWT
- Serves a minimal standalone frontend

## Quick start

1. Copy `.env.template` to `.env` and fill in values.
2. Install deps: `npm install`
3. Start the agent API: `npm run dev`
4. In another terminal, start the client: `npm run dev:client`
5. Open `http://localhost:5179`

Set `GHOSTFOLIO_API_URL` in `.env` to your Ghostfolio API base URL (no trailing slash).

## See the agent (chat UI) — simple connect flow

1. Start the agent: `npm run dev` (listens on `http://localhost:3334`).
2. In another terminal, start the client: `npm run dev:client` (serves the chat UI at `http://localhost:5179`).
3. Open `http://localhost:5179` in your browser.
4. The UI uses same-origin requests (`/api/...`) and Vite proxies them to the agent in dev mode.
5. **Connect with Ghostfolio** — either:
   - **JWT**: Log in at Ghostfolio in another tab; copy the JWT from the URL (e.g. `…/auth/eyJhbGciOi…`) and paste it in the agent UI, then click **Connect**, or  
   - **Access token**: If your Ghostfolio account has an access token (Settings → Account), paste it and click **Connect** (the agent will exchange it for a JWT).
6. Type a message and click Send to talk to the agent.

If the connect box stays visible, check the agent terminal for `Could not auto-exchange access token` and verify Ghostfolio is running and `GHOSTFOLIO_ACCESS_TOKEN` is the security token from Create Account.

## Using deployed or self-hosted Ghostfolio

Set `GHOSTFOLIO_API_URL` in `.env` to your Ghostfolio instance URL.

- **JWT**: Log in at your Ghostfolio URL (e.g. `…/en/home`), copy the JWT from the URL after redirect (e.g. `…/auth/eyJhbG…`), and paste it in the agent UI → **Connect**.
- **Access token**: In Ghostfolio go to Settings → Account, create/copy your access token, paste it in the agent UI → **Connect** (the agent exchanges it for a JWT).

If your agent UI is served from a different origin (e.g. another domain), set `CORS_ORIGIN` in `.env` to that origin so the browser can send the JWT to the agent.

## Evaluation

- **Unit tests**: `npm test` runs 5 Jest tests (agent service: direct response, portfolio snapshot, performance, synthesis, tool error handling).
- **Golden set evals**: data-retrieval cases in `src/server/evals/golden_sets/*.eval.yaml` using four deterministic check types — tool selection, source citation, content validation, negative validation. All checks are code evals: binary pass/fail, no LLM needed. See [docs/golden-set-checks.md](docs/golden-set-checks.md) for details.
- **Scenario evals**: advice/behavior cases in `src/server/evals/scenario_sets/*.eval.yaml` (e.g., buy/sell advice, prediction, tax-advice prompts). These are still deterministic checks but do not block CI by default.
- **Run golden set** against a live agent: set `EVAL_BASE_URL` and `EVAL_JWT` in `.env` (or use `GHOSTFOLIO_JWT` / `GHOSTFOLIO_ACCESS_TOKEN`), then:
  ```bash
  npm run evals:golden
  ```
- **Run scenarios**:
  ```bash
  npm run evals:scenarios
  ```
  Without `EVAL_BASE_URL` in `.env`, either command loads cases and prints what would run (dry run).

## Production build

1. Build server + client: `npm run build`
2. Start the server: `npm start`
3. Open `http://localhost:3334`

The server serves both the API and the built frontend from a single origin.

## Deploying the agent

### Option A: GCP Cloud Run (recommended)

1. **Prerequisites**: [Google Cloud SDK](https://cloud.google.com/sdk/docs/install), a GCP project, and an [Artifact Registry](https://cloud.google.com/artifact-registry/docs) repo (e.g. `portfolio-agent` in region `us-central1`).
2. **Build and push** the image. The client needs Supabase URL/keys at build time — set them as substitution variables when submitting the build:
   ```bash
   gcloud builds submit --config=cloudbuild.yaml \
     --substitutions=_VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co,_VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
   ```
   Or in the Cloud Console: create a Build Trigger, point it at this repo and `cloudbuild.yaml`, and add substitution variables `_VITE_SUPABASE_URL`, `_VITE_SUPABASE_ANON_KEY` (and optionally `_REGION`, `_REPO`, `_IMAGE`).
3. **Deploy to Cloud Run**:
   ```bash
   gcloud run deploy portfolio-agent \
     --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/portfolio-agent/agent:latest \
     --region us-central1 \
     --platform managed \
     --allow-unauthenticated
   ```
   Then set **environment variables** (and optionally secrets) in the Cloud Run service:
   - Required: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `DIRECT_URL`, `ENCRYPTION_KEY`, `ENCRYPTION_SALT`, `CORS_ORIGIN` (e.g. `https://your-service-xxx.run.app`)
   - Optional: `SUPABASE_SERVICE_ROLE_KEY`, `AGENT_ENABLE_MARKET`, SnapTrade, Langfuse, etc. (see `.env.template`).

4. **Database**: Run migrations once against your production DB:
   ```bash
   npx prisma migrate deploy
   ```
   Use the same `DATABASE_URL` / `DIRECT_URL` as in Cloud Run.

5. Cloud Run sets `PORT` automatically; the app listens on it. Set `CORS_ORIGIN` to your Cloud Run URL (or your frontend URL if you host the UI elsewhere).

### Option B: Docker

```bash
# Build
docker build -t portfolio-agent .

# Run (pass env or use --env-file)
docker run -p 3334:3334 \
  -e ANTHROPIC_API_KEY=your_key \
  -e CORS_ORIGIN=https://your-public-url \
  portfolio-agent
```

For production, use a platform that runs the container (GCP Cloud Run, Render, Fly.io, ECS, etc.) and set the same env vars there.

### Option C: Build and run on a VPS

```bash
npm ci
npm run build
PORT=3334 node dist/server/main.js
```

Use a process manager (e.g. systemd or PM2) and a reverse proxy (e.g. nginx) with HTTPS. Set env from `.env` or the process manager config.
