# Portfolio Agent

AI-powered portfolio analysis agent: natural-language queries over your brokerage data via Claude, SnapTrade, and Yahoo Finance. Users sign in with Supabase (OAuth or email), connect brokerages through SnapTrade, and chat with the agent for snapshots, performance, and allocation what-ifs.

## Project structure

```
portfolio-agent/
├── src/
│   ├── client/                 # Frontend (Vite + TypeScript)
│   │   ├── index.html
│   │   ├── main.ts             # Entry, Supabase auth, chat UI
│   │   ├── chat-history.ts     # Conversation state
│   │   └── styles.css
│   └── server/                 # Express API + agent
│       ├── main.ts             # App entry, routes, static client
│       ├── agent.service.ts    # ReAct loop, Claude tool-calling
│       ├── agent.config.ts     # Model, limits, prompts
│       ├── agent.prompt.ts
│       ├── agent.types.ts
│       ├── agent.verifier.ts   # Response verification / guardrails
│       ├── middleware/
│       │   └── auth.ts         # Supabase JWT verification
│       ├── services/
│       │   ├── portfolio.service.ts  # SnapTrade + Yahoo, 60s cache
│       │   └── snaptrade.service.ts  # Brokerage connections, encryption
│       ├── tools/              # Agent tools
│       │   ├── tool-registry.ts
│       │   ├── get-portfolio-snapshot.tool.ts
│       │   ├── get-performance.tool.ts
│       │   ├── simulate-allocation-change.tool.ts
│       │   ├── portfolio-read.tool.ts
│       │   ├── get-market-prices.tool.ts
│       │   └── snaptrade-connect.tool.ts
│       ├── lib/
│       │   ├── prisma.ts
│       │   ├── supabase.ts
│       │   ├── encrypt.ts      # Per-user credential encryption
│       │   └── yahoo.ts        # Yahoo Finance (curl + cache)
│       └── evals/
│           ├── run-evals.ts
│           ├── golden_sets/    # Data-retrieval eval cases
│           ├── sanity_sets/
│           └── scenario_sets/ # Advice/behavior cases
├── prisma/
│   ├── schema.prisma           # User, BrokerageConnection
│   └── migrations/
├── docs/
│   └── golden-set-checks.md
├── cloudbuild.yaml             # GCP Cloud Build
├── Dockerfile
└── .env.template
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for request flow, data model, and configuration.

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
| Simple evaluation: 5+ test cases with expected outcomes | ✓ (Jest unit tests; golden set in `golden_sets/*.eval.yaml`; scenario set in `scenario_sets/*.eval.yaml`) |
| Deployed and publicly accessible | Deploy via GCP Cloud Run, Docker, or VPS (see below) |

## What it does

- Exposes a chat API at `POST /api/chat` (Supabase JWT required).
- Uses Claude tool-calling in a ReAct loop; tools read from SnapTrade (holdings) and Yahoo Finance (prices), with optional market-prices tool when enabled.
- Serves a standalone frontend: sign in with Supabase (OAuth or email), optionally connect brokerages via SnapTrade Connection Portal, then chat with the agent.

## Quick start

1. Copy `.env.template` to `.env` and fill in values (see [Key configuration](#key-configuration) and `.env.template` comments).
2. Install deps: `npm install`
3. Set up Supabase (project, auth providers, URL + anon key). For brokerage data, set SnapTrade credentials and run Prisma migrations.
4. Start the agent API: `npm run dev`
5. In another terminal, start the client: `npm run dev:client`
6. Open `http://localhost:5179`

## See the agent (chat UI)

1. Start the agent: `npm run dev` (listens on `http://localhost:3334`).
2. In another terminal, start the client: `npm run dev:client` (chat UI at `http://localhost:5179`).
3. Open `http://localhost:5179` in your browser.
4. Sign in with Supabase (OAuth or email). The UI uses same-origin requests; Vite proxies `/api/*` to the agent in dev.
5. (Optional) Connect a brokerage: use the in-app flow that calls `/api/snaptrade/connect-url` and the SnapTrade Connection Portal. Portfolio tools are only available when at least one brokerage is connected.
6. Type a message and send to talk to the agent.

If you run without Supabase configured, the server can operate in dev mode with a single synthetic user; see [ARCHITECTURE.md](ARCHITECTURE.md) (Auth flow).

## Key configuration

| Purpose | Env vars |
|--------|----------|
| Auth & DB | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `DATABASE_URL`, `DIRECT_URL` |
| Brokerage | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` |
| Encryption | `ENCRYPTION_KEY`, `ENCRYPTION_SALT` (see `.env.template`) |
| Agent | `ANTHROPIC_API_KEY`, `AGENT_MODEL`, `AGENT_ENABLE_MARKET`, etc. (see [ARCHITECTURE.md](ARCHITECTURE.md)) |
| CORS | `CORS_ORIGIN` (e.g. your frontend or Cloud Run URL) |

If the UI is served from another origin, set `CORS_ORIGIN` in `.env` so the browser can send the JWT to the agent.

## Evaluation

- **Unit tests**: `npm test` (Jest; agent service and tool behavior).
- **Golden set evals**: data-retrieval cases in `src/server/evals/golden_sets/*.eval.yaml` (tool selection, source citation, content validation, negative validation). See [docs/golden-set-checks.md](docs/golden-set-checks.md).
- **Scenario evals**: `src/server/evals/scenario_sets/*.eval.yaml` (advice/behavior).
- **Run golden set** against a live agent: set `EVAL_BASE_URL` and `EVAL_JWT` in `.env`, then:
  ```bash
  npm run evals:golden
  ```
- **Run scenarios**:
  ```bash
  npm run evals:scenarios
  ```
  Without `EVAL_BASE_URL`, commands load cases and print what would run (dry run).

## Production build

1. Build server + client: `npm run build`
2. Start the server: `npm start`
3. Open `http://localhost:3334`

The server serves both the API and the built frontend from a single origin.

## Deploying the agent

### Option A: GCP Cloud Run (recommended)

See **[docs/deploy-gcp.md](docs/deploy-gcp.md)** for a step-by-step guide.

1. **Prerequisites**: [Google Cloud SDK](https://cloud.google.com/sdk/docs/install), a GCP project, and an [Artifact Registry](https://cloud.google.com/artifact-registry/docs) repo (e.g. `portfolio-agent` in region `us-central1`).
2. **Build and push** the image. The client needs Supabase URL/keys at build time. From the repo root, run `./scripts/gcp-build.sh` (reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `.env`), or pass them manually:
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
   Set **environment variables** (and optionally secrets) in the Cloud Run service:
   - Required: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `DIRECT_URL`, `ENCRYPTION_KEY`, `ENCRYPTION_SALT`, `CORS_ORIGIN` (e.g. `https://your-service-xxx.run.app`)
   - Optional: `SUPABASE_SERVICE_ROLE_KEY`, `SNAPTRADE_*`, `AGENT_ENABLE_MARKET`, Langfuse, etc. (see `.env.template`).
4. **Database**: Run migrations once against your production DB:
   ```bash
   npx prisma migrate deploy
   ```
   Use the same `DATABASE_URL` / `DIRECT_URL` as in Cloud Run.
5. Cloud Run sets `PORT` automatically. Set `CORS_ORIGIN` to your Cloud Run URL (or your frontend URL if you host the UI elsewhere).

### Option B: Docker

```bash
docker build -t portfolio-agent .
docker run -p 3334:3334 \
  -e ANTHROPIC_API_KEY=your_key \
  -e CORS_ORIGIN=https://your-public-url \
  portfolio-agent
```

Use a platform that runs the container (GCP Cloud Run, Render, Fly.io, ECS, etc.) and set the same env vars there.

### Option C: Build and run on a VPS

```bash
npm ci
npm run build
PORT=3334 node dist/server/main.js
```

Use a process manager (e.g. systemd or PM2) and a reverse proxy (e.g. nginx) with HTTPS. Set env from `.env` or the process manager config.
