// Catch-all forwarder for /v1/* endpoints that don't have a dedicated route.
// Covers moderations, images, audio (TTS/STT), assistants, threads, batches,
// files, fine_tuning, vector_stores, and any future OpenAI surface area.
//
// Streams the response so JSON, SSE, and binary (audio) all work.
// For non-JSON request bodies (multipart uploads), pipes the raw request.

const express = require('express');
const axios = require('axios');
const config = require('../config');
const { axiosProxyOptions } = require('../proxy/httpClient');

const router = express.Router();

const HOP_BY_HOP_RES_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'content-encoding',
]);

// Allowlist of headers safe to forward upstream. Anything not on this list
// (including cookies, dashboard session, custom auth) is dropped.
const FORWARDABLE_REQ_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'x-request-id',
  'x-stainless-lang',
  'x-stainless-package-version',
  'openai-beta',
  'openai-organization',
  'openai-project',
  'user-agent',
]);

const CAPTURE_JSON_BYTES = 16 * 1024;

router.all('*', async (req, res) => {
  if (config.upstream.provider === 'gemini') {
    return res.status(501).json({
      error: {
        message: `${req.method} ${req.originalUrl} is not supported when UPSTREAM_PROVIDER=gemini.`,
        type: 'not_implemented',
      },
    });
  }

  const targetUrl = config.upstream.baseUrl + req.originalUrl;
  const contentType = req.headers['content-type'] || '';
  const isJson = contentType.includes('application/json');

  // Build outbound headers from the allowlist; replace auth.
  const outHeaders = { Authorization: `Bearer ${config.upstream.apiKey}` };
  for (const [k, v] of Object.entries(req.headers)) {
    if (FORWARDABLE_REQ_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
  }

  const data = isJson
    ? (req.body && Object.keys(req.body).length ? req.body : undefined)
    : req;

  try {
    const upstream = await axios({
      method: req.method,
      url: targetUrl,
      data,
      headers: outHeaders,
      timeout: config.upstream.timeout,
      responseType: 'stream',
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      ...axiosProxyOptions(targetUrl),
    });

    req.trace?.('passthrough_upstream', { url: targetUrl, status: upstream.status });

    res.status(upstream.status);
    const upstreamCT = String(upstream.headers['content-type'] || '');
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP_RES_HEADERS.has(k.toLowerCase())) continue;
      res.setHeader(k, v);
    }

    // Tee the first 16 KB of small JSON responses into the log entry so the
    // dashboard can show non-streaming passthrough payloads.
    const entry = req._proxyEntry;
    const captureJson = entry && upstreamCT.includes('application/json');
    let captured = '';

    if (captureJson) {
      upstream.data.on('data', chunk => {
        if (captured.length < CAPTURE_JSON_BYTES) {
          const room = CAPTURE_JSON_BYTES - captured.length;
          captured += chunk.toString('utf8', 0, Math.min(chunk.length, room));
        }
      });
      upstream.data.on('end', () => {
        if (entry) entry.responseBody = captured;
      });
    }

    upstream.data.on('error', err => {
      console.error('[passthrough] upstream stream error:', err.message);
      req.setError?.(`stream error: ${err.message}`);
      req.trace?.('passthrough_stream_error', { error: err.message });
      if (!res.writableEnded) res.end();
    });

    req.on('close', () => {
      if (!upstream.data.destroyed) upstream.data.destroy();
    });

    upstream.data.pipe(res);
  } catch (err) {
    console.error(`[passthrough] ${req.method} ${req.originalUrl} error:`, err.message);
    res.status(502).json({
      error: { message: 'Upstream error: ' + err.message, type: 'proxy_error' },
    });
  }
});

module.exports = router;
