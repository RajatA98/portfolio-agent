import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';

import { agentConfig } from './agent.config';
import { AgentService, StreamEvent } from './agent.service';
import { ChatService, type ChatMessagePayload } from './services/chat.service';
import { AgentChatRequest } from './agent.types';
import { getPrisma } from './lib/prisma';
import { AuthenticatedRequest, requireAuth } from './middleware/auth';
import { SnapTradeService } from './services/snaptrade.service';
import { UsageService } from './services/usage.service';

const app = express();
const agentService = new AgentService();
const usageService = new UsageService();

app.use(
  cors({
    origin: agentConfig.corsOrigin
  })
);

// Stripe webhook must receive raw body for signature verification (register before express.json)
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!agentConfig.stripeEnabled || !agentConfig.stripeWebhookSecret) {
      res.status(501).send('Stripe webhook not configured');
      return;
    }
    const sig = req.headers['stripe-signature'] as string | undefined;
    if (!sig) {
      res.status(400).send('Missing stripe-signature');
      return;
    }
    const rawBody = req.body as Buffer;
    let event: Stripe.Event;
    try {
      const stripe = new Stripe(agentConfig.stripeSecretKey);
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        agentConfig.stripeWebhookSecret
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[stripe] Webhook signature verification failed:', msg);
      res.status(400).send(`Webhook Error: ${msg}`);
      return;
    }
    const prisma = getPrisma();
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.client_reference_id as string | null;
          if (!userId) break;
          const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          if (!customerId || !subscriptionId) break;
          await prisma.user.update({
            where: { id: userId },
            data: {
              stripeCustomerId: customerId,
              subscriptionId,
              subscriptionStatus: 'active'
            }
          });
          break;
        }
        case 'customer.subscription.updated': {
          const sub = event.data.object as Stripe.Subscription;
          await prisma.user.updateMany({
            where: { subscriptionId: sub.id },
            data: { subscriptionStatus: sub.status === 'active' ? 'active' : 'past_due' }
          });
          break;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          await prisma.user.updateMany({
            where: { subscriptionId: sub.id },
            data: { subscriptionStatus: 'canceled', subscriptionId: null }
          });
          break;
        }
        default:
          // ignore other events
          break;
      }
    } catch (err) {
      console.error('[stripe] Webhook handler error:', err);
      res.status(500).send('Webhook handler failed');
      return;
    }
    res.sendStatus(200);
  }
);

app.use(express.json({ limit: '1mb' }));

// --- Health check (no auth) ---
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// --- SnapTrade callback (no auth — loaded in popup after brokerage connect) ---
app.get('/snaptrade/callback', (_req, res) => {
  res.send(`<!DOCTYPE html><html><body>
<p>Brokerage connected! This window will close automatically.</p>
<script>
  if (window.opener) window.opener.postMessage('snaptrade-connected', '*');
  setTimeout(() => window.close(), 500);
</script>
</body></html>`);
});

// --- All /api routes require Supabase auth ---
app.use('/api', requireAuth);

// --- Auth routes ---
app.get('/api/auth/status', (req, res) => {
  const authReq = req as AuthenticatedRequest;
  res.json({ authenticated: true, userId: authReq.userId });
});

// --- Profile route ---
app.get('/api/profile', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.userId!;
  const prisma = getPrisma();
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionStatus: true, email: true }
    });
    const tokensUsed = await usageService.getTotalTokensThisPeriod(userId);
    res.json({
      subscriptionStatus: user?.subscriptionStatus ?? 'free',
      tokensUsed,
      tokenLimit: agentConfig.freeTierDailyTokenLimit
    });
  } catch {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// --- Encrypted Chat Persistence ---
const chatService = new ChatService();

app.get('/api/chats', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const chats = await chatService.listChats(authReq.userId!);
    res.json({ chats });
  } catch {
    res.status(500).json({ error: 'Failed to load chats' });
  }
});

app.post('/api/chats', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { title } = req.body as { title?: string };
    const chat = await chatService.createChat(authReq.userId!, title);
    res.json(chat);
  } catch {
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

app.delete('/api/chats/:chatId', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    await chatService.deleteChat(authReq.userId!, req.params.chatId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

app.patch('/api/chats/:chatId', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const { title } = req.body as { title?: string };
  if (!title) { res.status(400).json({ error: 'title required' }); return; }
  try {
    await chatService.renameChat(authReq.userId!, req.params.chatId, title);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to rename chat' });
  }
});

app.get('/api/chats/:chatId/messages', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const messages = await chatService.getMessages(
      authReq.userId!, authReq.supabaseUserId!, req.params.chatId
    );
    res.json({ messages });
  } catch {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/chats/:chatId/messages', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const msg = req.body as { role: string; content: string; confidence?: number; warnings?: string[] };
    await chatService.appendMessage(
      authReq.userId!, authReq.supabaseUserId!, req.params.chatId,
      { role: msg.role as 'user' | 'assistant', content: msg.content, confidence: msg.confidence, warnings: msg.warnings }
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save message' });
  }
});

app.post('/api/chats/sync', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const raw = req.body as { chats: Array<{ title: string; createdAt?: number; messages?: Array<{ role: string; content: string; confidence?: number; warnings?: string[] }> }> };
    const chats = raw.chats.map((c) => ({
      title: c.title,
      createdAt: c.createdAt,
      messages: (c.messages ?? []).map((m): ChatMessagePayload => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        confidence: m.confidence,
        warnings: m.warnings
      }))
    }));
    const results = await chatService.bulkSync(
      authReq.userId!, authReq.supabaseUserId!, chats
    );
    res.json({ results });
  } catch (error) {
    console.error('[chat/sync] error:', error);
    res.status(500).json({ error: 'Failed to sync chats' });
  }
});

// --- Stripe checkout (requires Stripe env vars) ---
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  if (!agentConfig.stripeEnabled) {
    res.status(503).json({ error: 'Billing not configured' });
    return;
  }
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.userId!;
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, email: true }
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const baseUrl = agentConfig.corsOrigin || 'http://localhost:5179';
  try {
    const stripe = new Stripe(agentConfig.stripeSecretKey);
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [{ price: agentConfig.stripePriceIdPro, quantity: 1 }],
      success_url: `${baseUrl}/app?checkout=success`,
      cancel_url: `${baseUrl}/app?checkout=cancel`,
      client_reference_id: userId,
      allow_promotion_codes: true
    };
    if (user.stripeCustomerId) {
      sessionParams.customer = user.stripeCustomerId;
    } else if (user.email) {
      sessionParams.customer_email = user.email;
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe] Create checkout session failed:', msg);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// --- Chat route ---
app.post('/api/chat', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId!;

    const body = req.body as AgentChatRequest;
    if (!body?.message || typeof body.message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // Free-tier token limit check (skip for active subscribers)
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionStatus: true }
    });
    const isPro = user?.subscriptionStatus === 'active';
    if (!isPro) {
      const used = await usageService.getTotalTokensThisPeriod(userId);
      const limit = agentConfig.freeTierDailyTokenLimit;
      if (used >= limit) {
        res.status(402).json({
          limitReached: true,
          used,
          limit,
          upgradeUrl: '/api/stripe/create-checkout-session'
        });
        return;
      }
    }

    const response = await agentService.chat(body, {
      userId,
      supabaseUserId: authReq.supabaseUserId,
      baseCurrency: body.baseCurrency ?? 'USD',
      language: body.language ?? 'en'
    });

    // Record token usage for free-tier enforcement
    const tokenUsage = response.loopMeta?.tokenUsage;
    if (tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0)) {
      await usageService
        .recordUsage(userId, tokenUsage.inputTokens, tokenUsage.outputTokens)
        .catch((err) => console.error('[usage] record failed:', err));
    }

    res.json(response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: `Agent request failed: ${msg}`
    });
  }
});

// --- Streaming chat route (SSE) ---
app.post('/api/chat/stream', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.userId!;

  const body = req.body as AgentChatRequest;
  if (!body?.message || typeof body.message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  // Free-tier token limit check (skip for active subscribers)
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionStatus: true }
  });
  const isPro = user?.subscriptionStatus === 'active';
  if (!isPro) {
    const used = await usageService.getTotalTokensThisPeriod(userId);
    const limit = agentConfig.freeTierDailyTokenLimit;
    if (used >= limit) {
      res.status(402).json({
        limitReached: true,
        used,
        limit,
        upgradeUrl: '/api/stripe/create-checkout-session'
      });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendSSE = (event: StreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const response = await agentService.chat(
      body,
      {
        userId,
        supabaseUserId: authReq.supabaseUserId,
        baseCurrency: body.baseCurrency ?? 'USD',
        language: body.language ?? 'en'
      },
      sendSSE
    );

    // Record token usage for free-tier enforcement
    const tokenUsage = response.loopMeta?.tokenUsage;
    if (tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0)) {
      await usageService
        .recordUsage(userId, tokenUsage.inputTokens, tokenUsage.outputTokens)
        .catch((err) => console.error('[usage] record failed:', err));
    }

    // Send final done event
    sendSSE({
      type: 'done',
      answer: response.answer,
      confidence: response.confidence,
      warnings: response.warnings,
      toolTrace: response.toolTrace,
      loopMeta: response.loopMeta
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendSSE({ type: 'error', message: msg });
  }

  res.end();
});

// --- SnapTrade routes (conditionally available) ---
if (agentConfig.enableSnapTrade) {
  const snapTradeService = new SnapTradeService();

  app.post('/api/snaptrade/register', async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId!;
    const supabaseUserId = authReq.supabaseUserId!;

    try {
      const result = await snapTradeService.registerUser(userId, supabaseUserId);
      res.json({ snaptradeUserId: result.snaptradeUserId });
    } catch (error: unknown) {
      const is401 = String(error).includes('401');
      if (!is401) {
        console.error('[snaptrade/register] error:', SnapTradeService.sanitizeError(error));
        res.status(500).json({ error: SnapTradeService.sanitizeError(error) });
        return;
      }

      // Stale credentials — refresh the secret (preserves brokerage connections)
      console.log('[snaptrade/register] 401 detected, refreshing credentials...');
      try {
        const refreshed = await snapTradeService.refreshCredentials(userId, supabaseUserId);
        res.json({ snaptradeUserId: refreshed.snaptradeUserId });
      } catch (retryError) {
        console.error('[snaptrade/register] refresh failed:', SnapTradeService.sanitizeError(retryError));
        res.status(500).json({
          error: SnapTradeService.sanitizeError(retryError)
        });
      }
    }
  });

  app.get('/api/snaptrade/connect-url', async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const protocol = req.headers['x-forwarded-proto'] ?? req.protocol;
    const host = req.headers['x-forwarded-host'] ?? req.get('host');
    const callbackUrl = `${protocol}://${host}/snaptrade/callback`;

    try {
      const result = await snapTradeService.getConnectUrl(authReq.userId!, authReq.supabaseUserId!, callbackUrl);
      res.json(result);
    } catch (error) {
      const is401 = String(error).includes('401');
      if (!is401) {
        res.status(500).json({ error: SnapTradeService.sanitizeError(error) });
        return;
      }
      // 401 = stale credentials. Refresh and retry.
      console.log('[snaptrade/connect-url] 401 detected, refreshing credentials...');
      try {
        await snapTradeService.refreshCredentials(authReq.userId!, authReq.supabaseUserId!);
        const result = await snapTradeService.getConnectUrl(authReq.userId!, authReq.supabaseUserId!, callbackUrl);
        res.json(result);
      } catch (retryError) {
        // Refresh also failed — delete stale record so next register starts fresh
        console.error('[snaptrade/connect-url] refresh failed:', SnapTradeService.sanitizeError(retryError));
        await snapTradeService.deleteConnection(authReq.userId!).catch(() => {});
        res.status(500).json({
          error: 'Brokerage credentials expired. Please click Connect Brokerage again.'
        });
      }
    }
  });

  app.get('/api/snaptrade/connections', async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const connections = await snapTradeService.listConnections(authReq.userId!, authReq.supabaseUserId!);
      res.json({ connections });
    } catch (error) {
      const is401 = String(error).includes('401');
      if (!is401) {
        res.status(500).json({ error: SnapTradeService.sanitizeError(error) });
        return;
      }
      // 401 = stale. Refresh and retry.
      try {
        await snapTradeService.refreshCredentials(authReq.userId!, authReq.supabaseUserId!);
        const connections = await snapTradeService.listConnections(authReq.userId!, authReq.supabaseUserId!);
        res.json({ connections });
      } catch {
        // Stale beyond repair — return empty so UI shows "NO BROKERAGE"
        await snapTradeService.deleteConnection(authReq.userId!).catch(() => {});
        res.json({ connections: [] });
      }
    }
  });

  app.get('/api/snaptrade/accounts', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const accounts = await snapTradeService.listAccounts(authReq.userId!, authReq.supabaseUserId!);
      res.json({ accounts });
    } catch (error) {
      res.status(500).json({ error: SnapTradeService.sanitizeError(error) });
    }
  });

  // --- Verify accounts after connection (duplicate detection) ---
  app.post('/api/snaptrade/verify-accounts', async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId!;
    const supabaseUserId = authReq.supabaseUserId!;
    const prisma = getPrisma();

    try {
      const accounts = await snapTradeService.listAccounts(userId, supabaseUserId);

      if (accounts.length === 0) {
        res.json({ ok: true });
        return;
      }

      // Check if any account is already linked to a different user
      for (const account of accounts) {
        const existing = await prisma.linkedAccount.findUnique({
          where: { brokerageAccountId: account.id },
          include: { user: { select: { id: true, email: true } } }
        });

        if (existing && existing.userId !== userId) {
          // Duplicate detected — remove the SnapTrade connection for this user
          console.log(`[snaptrade] duplicate account detected: ${account.id} (${account.institutionName}) already linked to user ${existing.userId}`);

          // Delete the brokerage connection so this user can't access the other user's data
          await snapTradeService.deleteConnection(userId);

          res.status(409).json({
            error: 'duplicate_account',
            message: `This brokerage account (${account.institutionName}) is already connected to a different Portfolio Terminal account. Each brokerage account can only be linked to one account.`
          });
          return;
        }
      }

      // No duplicates — register all accounts for this user
      for (const account of accounts) {
        await prisma.linkedAccount.upsert({
          where: { brokerageAccountId: account.id },
          create: {
            userId,
            brokerageAccountId: account.id,
            institutionName: account.institutionName,
            accountName: account.name
          },
          update: {
            userId,
            institutionName: account.institutionName,
            accountName: account.name
          }
        });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error('[snaptrade/verify-accounts] error:', SnapTradeService.sanitizeError(error));
      res.status(500).json({ error: SnapTradeService.sanitizeError(error) });
    }
  });

  app.get('/api/snaptrade/holdings', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await snapTradeService.getHoldings(authReq.userId!, authReq.supabaseUserId!);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: SnapTradeService.sanitizeError(error) });
    }
  });
}

// --- Serve built client ---
const clientDistPath = path.resolve(__dirname, '../client');
const clientIndexPath = path.join(clientDistPath, 'index.html');
const landingPath = path.join(clientDistPath, 'landing.html');
const hasBuiltClient = existsSync(clientIndexPath);

if (hasBuiltClient) {
  // Landing page at root (before static middleware so index.html doesn't override)
  app.get('/', (_req, res) => {
    if (existsSync(landingPath)) {
      res.sendFile(landingPath);
    } else {
      res.sendFile(clientIndexPath);
    }
  });

  // App at /app
  app.get('/app', (_req, res) => {
    res.sendFile(clientIndexPath);
  });

  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/snaptrade/callback') {
      next();
      return;
    }
    res.sendFile(clientIndexPath);
  });
}

// --- Start ---
app.listen(agentConfig.port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Portfolio Analyzer listening on 0.0.0.0:${agentConfig.port}`);
});

// Catch unhandled errors so Railway logs show them
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
