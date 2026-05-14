const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config'); // loads dotenv internally
const auth = require('./middleware/auth');
const requestLogger = require('./middleware/logger');
const staticReply = require('./middleware/staticReply');
const { isAuthenticated } = require('./middleware/dashboardAuth');
const httpClient = require('./proxy/httpClient');

process.on('unhandledRejection', err => {
  console.error('Unhandled promise rejection:', err);
});
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});

const app = express();

// Honors X-Forwarded-* when running behind a reverse proxy.
// Set TRUST_PROXY=true (loopback hop), a number (hops), or a CIDR list.
// See https://expressjs.com/en/guide/behind-proxies.html
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', v === 'true' ? true : (/^\d+$/.test(v) ? Number(v) : v));
}

// CORS — must come before auth so preflight OPTIONS passes through
const corsOptions = {
  origin: config.corsOrigins === '*' ? '*' : config.corsOrigins.split(',').map(o => o.trim()),
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'OpenAI-Beta'],
  exposedHeaders: ['X-Request-ID'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // explicit preflight handler

app.use(express.json({ limit: '10mb' }));
app.use(morgan(config.logLevel === 'debug' ? 'dev' : 'combined'));

// Health check (no auth) — n8n can ping this to verify connectivity
app.get('/health', (req, res) => {
  res.json({ status: 'ok', upstream: config.upstream.baseUrl, provider: config.upstream.provider });
});

// Dashboard (static page + API)
app.use('/dashboard', require('./routes/dashboard'));

// Protect the main dashboard page — redirect to /login only when DASHBOARD_PASSWORD
// is configured. If only DASHBOARD_TOKEN is set, the legacy query-param/bearer flow
// still works and we must NOT redirect to /login (the form there can't handle tokens).
app.get(['/', '/index.html'], (req, res, next) => {
  if (process.env.DASHBOARD_PASSWORD && !isAuthenticated(req)) return res.redirect('/login');
  next();
});

// Serve login page explicitly — express.static only matches /login.html, not /login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Logger runs first so every /v1 request is captured, including auth failures.
app.use('/v1', requestLogger);
app.use('/v1', auth);
app.use('/v1/models', require('./routes/models'));
// Static reply check runs before any route forwards to the upstream LLM.
// Mounted globally on /v1 so passthrough endpoints are also covered.
app.use('/v1', staticReply);
app.use('/v1/chat', require('./routes/chat'));
app.use('/v1/completions', require('./routes/completions'));
app.use('/v1/responses', require('./routes/responses'));
app.use('/v1/embeddings', require('./routes/embeddings'));

// Catch-all: forwards any other /v1/* path (moderations, images, audio,
// assistants, threads, files, batches, fine_tuning, vector_stores, ...)
// to the upstream when provider=openai. Gemini gets a 501.
app.use('/v1', require('./routes/passthrough'));

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Unknown route: ${req.method} ${req.path}`,
      type: 'invalid_request_error',
    },
  });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: { message: 'Internal proxy error', type: 'proxy_error' },
  });
});

// Refuse to start when the dashboard is bound publicly without auth.
// This stops a default-install from leaking prompt history to the internet.
const isPublicBind = !['127.0.0.1', 'localhost', '::1'].includes(config.host);
const dashboardOpen = !process.env.DASHBOARD_PASSWORD && !process.env.DASHBOARD_TOKEN;
if (isPublicBind && dashboardOpen && process.env.DASHBOARD_OPEN !== 'true') {
  console.error('FATAL: dashboard would be publicly reachable on ' + config.host + ':' + config.port + ' with no auth.');
  console.error('       Set DASHBOARD_PASSWORD (recommended) or DASHBOARD_TOKEN in .env, or set HOST=127.0.0.1.');
  console.error('       To override (NOT recommended for production), set DASHBOARD_OPEN=true.');
  process.exit(1);
}

// Warn when UPSTREAM_BASE_URL points at a private/loopback host — common in
// dev/Ollama setups, but also a SSRF foot-gun if .env is editable by less
// trusted users. Opt out with ALLOW_PRIVATE_UPSTREAM=true to silence.
try {
  const u = new URL(config.upstream.baseUrl);
  const h = u.hostname;
  const isPrivate = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|fc[0-9a-f]{2}:|fe80:)/i.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (isPrivate && process.env.ALLOW_PRIVATE_UPSTREAM !== 'true') {
    console.warn(`WARNING: UPSTREAM_BASE_URL points at a private host (${h}). Set ALLOW_PRIVATE_UPSTREAM=true to silence.`);
  }
} catch { /* invalid URL — let the proxy fail on first request */ }

app.listen(config.port, config.host, () => {
  console.log(`AI Proxy listening on http://${config.host}:${config.port}`);
  console.log(`Upstream: ${config.upstream.provider} → ${config.upstream.baseUrl}`);
  if (!config.proxyApiKey) {
    console.warn('WARNING: PROXY_API_KEY is not set — all requests are unauthenticated');
  }
  if (config.corsOrigins) {
    console.log(`CORS origins: ${config.corsOrigins}`);
  }
  console.log(`Dashboard:  http://${config.host}:${config.port}/`);
  console.log(`Outbound:   ${httpClient.describe()}`);
});
