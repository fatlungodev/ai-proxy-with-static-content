const express = require('express');
const logStore = require('../logStore');
const config = require('../config');
const httpClient = require('../proxy/httpClient');

const router = express.Router();

// Optional dashboard auth — set DASHBOARD_TOKEN in .env to require it.
function dashboardAuth(req, res, next) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return next();
  const provided =
    req.query.token ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (provided !== token) {
    return res.status(401).json({ error: 'Invalid dashboard token' });
  }
  next();
}

router.use(dashboardAuth);

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

module.exports = router;
