const express = require('express');
const logStore = require('../logStore');
const config = require('../config');
const httpClient = require('../proxy/httpClient');
const staticRules = require('../staticRules');
const { isAuthenticated, expectedToken, requireAuth, safeEqual, COOKIE_NAME } = require('../middleware/dashboardAuth');

const router = express.Router();

// ── Brute-force protection for login ─────────────────────────────────────────

const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

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
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: now + LOCKOUT_MS };
  entry.count++;
  entry.lockedUntil = now + LOCKOUT_MS;
  loginAttempts.set(ip, entry);
}

// ── Login / logout (no auth required) ────────────────────────────────────────

function cookieFlags(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

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
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags(req)}; Max-Age=0`);
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

module.exports = router;
