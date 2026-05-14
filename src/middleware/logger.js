const logStore = require('../logStore');
const config = require('../config');

const MAX_BODY_SNIPPET = 2000;

// LOG_CAPTURE_BODIES:
//   off     — never store request/response bodies
//   snippet — store redacted, truncated bodies (default)
//   full    — store redacted bodies untruncated (still subject to MAX_BODY_SNIPPET cap × 4)
const CAPTURE_BODIES = (process.env.LOG_CAPTURE_BODIES || 'snippet').toLowerCase();
const BODY_LIMIT = CAPTURE_BODIES === 'full' ? MAX_BODY_SNIPPET * 4 : MAX_BODY_SNIPPET;

const SENSITIVE_KEY = /^(authorization|api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|cookie|x[_-]api[_-]key|x[_-]auth[_-]token|set[_-]cookie|bearer)$/i;

function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function snippet(obj) {
  if (CAPTURE_BODIES === 'off' || obj == null) return null;
  const safe = typeof obj === 'object' ? redact(obj) : obj;
  let s;
  try { s = typeof safe === 'string' ? safe : JSON.stringify(safe); }
  catch { s = String(safe); }
  if (s.length > BODY_LIMIT) s = s.slice(0, BODY_LIMIT) + '… (truncated)';
  return s;
}

// Captures req/res into the log store. Mounted at /v1 so every request here is logged.
// Sets req._proxyEntry and req.trace() so downstream middleware can annotate the entry.
module.exports = function logger(req, res, next) {
  const start = Date.now();
  const entry = {
    id: null,
    timestamp: start,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    model: req.body?.model || null,
    stream: req.body?.stream === true,
    status: null,
    durationMs: null,
    error: null,
    requestBody: snippet(req.body),
    responseBody: null,
    bytesIn: parseInt(req.headers['content-length'] || '0', 10),
    bytesOut: 0,
    clientIp: req.ip,
    trace: [],
  };

  req._proxyEntry = entry;
  req.trace = (event, data = {}) => {
    entry.trace.push({ ms: Date.now() - start, event, ...data });
    if (config.logLevel === 'debug') {
      console.log(`[trace] ${req.method} ${req.path} +${Date.now() - start}ms ${event}`, data);
    }
  };
  // Downstream modules (streamPipe, passthrough) use this to attach response bodies.
  req.setResponseBody = (body) => { entry.responseBody = snippet(body); };
  req.setError = (msg) => { if (!entry.error) entry.error = String(msg); };

  // Intercept res.json to capture response body (non-stream path)
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    entry.responseBody = snippet(data);
    if (data && data.error) entry.error = data.error.message || String(data.error);
    return originalJson(data);
  };

  let bytesOut = 0;
  const origWrite = res.write.bind(res);
  res.write = (chunk, ...rest) => {
    if (chunk) bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    return origWrite(chunk, ...rest);
  };

  let recorded = false;
  function record() {
    if (recorded) return;
    recorded = true;
    logStore.add(entry);
  }

  res.on('finish', () => {
    entry.status = res.statusCode;
    entry.durationMs = Date.now() - start;
    entry.bytesOut = bytesOut || parseInt(res.getHeader('content-length') || '0', 10);
    if (!entry.error && res.statusCode >= 400) entry.error = `HTTP ${res.statusCode}`;
    record();
  });

  res.on('close', () => {
    if (!res.writableEnded && !recorded) {
      entry.status = 0;
      entry.error = 'Client disconnected before response completed';
      entry.durationMs = Date.now() - start;
      record();
    }
  });

  next();
};
