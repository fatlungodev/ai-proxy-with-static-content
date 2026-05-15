const express = require('express');
const logStore = require('../logStore');
const config = require('../config');
const httpClient = require('../proxy/httpClient');
const staticRules = require('../staticRules');
const { isAuthenticated, expectedToken, requireAuth, safeEqual, COOKIE_NAME, cookieFlags } = require('../middleware/dashboardAuth');

const router = express.Router();

// ── Brute-force protection for login ─────────────────────────────────────────

const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPT_ENTRIES = 10_000;

// Periodically drop expired entries so a spray of unique source IPs can't
// grow the map indefinitely.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.lockedUntil) loginAttempts.delete(ip);
  }
}, 60_000).unref();

function getClientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function isLoginRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.lockedUntil) { loginAttempts.delete(ip); return false; }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginFailure(ip) {
  // Hard cap on map size to defend against unique-IP-spray DoS.
  if (loginAttempts.size >= MAX_ATTEMPT_ENTRIES && !loginAttempts.has(ip)) {
    // Drop oldest entry — Map iteration order is insertion order.
    const firstKey = loginAttempts.keys().next().value;
    if (firstKey) loginAttempts.delete(firstKey);
  }
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: now + LOCKOUT_MS };
  entry.count++;
  entry.lockedUntil = now + LOCKOUT_MS;
  loginAttempts.set(ip, entry);
}

// ── Login / logout (no auth required) ────────────────────────────────────────

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return res.redirect('/');

  const ip = getClientIp(req);
  if (isLoginRateLimited(ip)) {
    return res.status(429).send('Too many failed attempts. Try again in 15 minutes.');
  }

  const provided = String(req.body.password || '').trim();
  if (!safeEqual(provided, password)) {
    recordLoginFailure(ip);
    return res.redirect('/login?error=1');
  }

  loginAttempts.delete(ip); // reset on success
  const token = expectedToken(password);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieFlags(req)}`);
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags(req, 0)}`);
  res.redirect('/login');
});

// ── All routes below require authentication ───────────────────────────────────

router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json({
    ...logStore.status(),
    upstream: {
      baseUrl: config.upstream.baseUrl,
      provider: config.upstream.provider,
      outbound: httpClient.describe(),
    },
    config: {
      port: config.port,
      defaultModel: config.defaultModel,
      allowedModels: config.allowedModels,
      localModels: config.localModels,
      authEnabled: !!config.proxyApiKey,
      loginEnabled: !!process.env.DASHBOARD_PASSWORD,
    },
  });
});

router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const sinceId = parseInt(req.query.sinceId || '0', 10);
  const level = req.query.level || null;
  res.json({ entries: logStore.list({ limit, sinceId, level }) });
});

router.get('/logs/download', (req, res) => {
  const st = logStore.status();
  const bundle = {
    exportedAt: new Date().toISOString(),
    server: {
      startedAt: new Date(st.startedAt).toISOString(),
      uptimeMs: st.uptimeMs,
      bufferSize: st.bufferSize,
      maxBufferSize: st.maxBufferSize,
      totals: st.totals,
    },
    upstream: {
      provider: config.upstream.provider,
      baseUrl: config.upstream.baseUrl,
    },
    config: {
      port: config.port,
      defaultModel: config.defaultModel,
      allowedModels: config.allowedModels,
      authEnabled: !!config.proxyApiKey,
    },
    rules: staticRules.list(),
    appEvents: logStore.getAppEvents(),
    logs: logStore.list({ limit: 500 }),
  };
  const filename = `ai-proxy-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(bundle, null, 2));
});

// Server-sent events stream of new log entries.
router.get('/logs/stream', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send a heartbeat every 25s so proxies don't time out.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  const unsubscribe = logStore.subscribe(entry => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ── Static reply rules CRUD ──────────────────────────────────────────────────

router.get('/rules', (req, res) => {
  res.json({ rules: staticRules.list() });
});

router.post('/rules', (req, res) => {
  try {
    const rule = staticRules.add(req.body);
    res.status(201).json(rule);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/rules/:id', (req, res) => {
  try {
    const updated = staticRules.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Rule not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/rules/:id', (req, res) => {
  const deleted = staticRules.remove(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Rule not found' });
  res.status(204).end();
});

// Bulk import. Body: { rules: [...], mode: 'replace' | 'upsert' }.
// Replace mode validates all rules first and either fully succeeds or fully
// rejects (atomic). Upsert mode matches incoming rules to existing ones by
// name (case-sensitive): a match replaces that rule's mutable fields in
// place, a miss appends as a new rule. Also atomic — validation runs up
// front so a bad row can't leave half the import applied. Legacy callers
// that still send `mode: 'merge'` are transparently treated as upsert.
router.post('/rules/import', (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body) ? body : body.rules;
  const mode = body.mode === 'replace' ? 'replace' : 'upsert';
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: 'request body must be an array or { rules: [...] }' });
  }
  try {
    if (mode === 'replace') {
      const result = staticRules.replaceAll(incoming);
      return res.json({ mode, count: result.length, errors: [] });
    }
    const result = staticRules.upsertByName(incoming);
    return res.json({
      mode,
      count: result.updated + result.added,
      updated: result.updated,
      added: result.added,
      errors: [],
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
