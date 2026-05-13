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
// Static reply check runs before forwarding to upstream LLM
app.use('/v1/chat', staticReply);
app.use('/v1/completions', staticReply);
app.use('/v1/responses', staticReply);
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
