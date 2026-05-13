const logStore = require('../logStore');

const MAX_BODY_SNIPPET = 2000; // chars stored per request/response

function snippet(obj) {
  if (obj == null) return null;
  let s;
  try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); }
  catch { s = String(obj); }
  if (s.length > MAX_BODY_SNIPPET) s = s.slice(0, MAX_BODY_SNIPPET) + '… (truncated)';
  return s;
}

// Captures req/res into the log store. Mounted at /v1 so every request here is logged.
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
  };

  // Intercept res.json to capture response body (non-stream path)
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    entry.responseBody = snippet(data);
    if (data && data.error) entry.error = data.error.message || String(data.error);
    return originalJson(data);
  };

  // Capture byte counts and finalize on response end
  let bytesOut = 0;
  const origWrite = res.write.bind(res);
  res.write = (chunk, ...rest) => {
    if (chunk) bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    return origWrite(chunk, ...rest);
  };

  res.on('finish', () => {
    entry.status = res.statusCode;
    entry.durationMs = Date.now() - start;
    entry.bytesOut = bytesOut || parseInt(res.getHeader('content-length') || '0', 10);
    if (!entry.error && res.statusCode >= 400) entry.error = `HTTP ${res.statusCode}`;
    logStore.add(entry);
  });

  res.on('close', () => {
    if (!res.writableEnded && entry.status == null) {
      entry.status = 0;
      entry.error = 'Client disconnected before response completed';
      entry.durationMs = Date.now() - start;
      logStore.add(entry);
    }
  });

  next();
};
