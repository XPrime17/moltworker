import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');
  
  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }
    
    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({ ok: false, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// POST /telegram/webhook - Telegram webhook endpoint (MUST be public for Telegram to reach it)
// This proxies webhook calls to the clawdbot gateway running inside the container
publicRoutes.post('/telegram/webhook', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const body = await c.req.text();
    console.log('[telegram-webhook] Received update:', body.slice(0, 500));

    // Forward to clawdbot gateway's webhook endpoint
    // The gateway listens on port 18789 and has a /telegram/webhook endpoint
    const gatewayUrl = `http://localhost:${MOLTBOT_PORT}/telegram/webhook`;

    const response = await sandbox.fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body,
    });

    const responseText = await response.text();
    console.log('[telegram-webhook] Gateway response:', response.status, responseText.slice(0, 200));

    return new Response(responseText, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[telegram-webhook] Error:', err);
    // Return 200 to Telegram to prevent retries
    return c.json({ ok: true, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// GET /debug-public - Temporary public debug endpoint (no auth)
publicRoutes.get('/debug-public', async (c) => {
  const sandbox = c.get('sandbox');
  const results: Record<string, unknown> = {};

  try {
    // Get process list
    const processes = await sandbox.listProcesses();
    results.processes = processes.map(p => ({
      id: p.id,
      command: p.command,
      status: p.status,
    }));

    // Get gateway process logs
    const gatewayProc = processes.find(p =>
      p.command.includes('clawdbot gateway') || p.command.includes('start-moltbot')
    );
    if (gatewayProc) {
      const logs = await gatewayProc.getLogs();
      results.gatewayLogs = {
        stdout: logs.stdout?.slice(-3000) || '',
        stderr: logs.stderr?.slice(-1000) || '',
      };
    }

    // Check config
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await new Promise(r => setTimeout(r, 2000));
    const configLogs = await configProc.getLogs();
    try {
      results.config = JSON.parse(configLogs.stdout || '{}');
    } catch {
      results.configRaw = configLogs.stdout;
    }

    return c.json(results);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export { publicRoutes };
