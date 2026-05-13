// Catch-all forwarder for /v1/* endpoints that don't have a dedicated route.
// Covers moderations, images, audio (TTS/STT), assistants, threads, batches,
// files, fine_tuning, vector_stores, and any future OpenAI surface area.
//
// Streams the response so JSON, SSE, and binary (audio) all work.
// For non-JSON request bodies (multipart uploads), pipes the raw request.
//
// Gemini doesn't have analogous endpoints — returns 501 with a clear message.

const express = require('express');
const axios = require('axios');
const config = require('../config');
const { axiosProxyOptions } = require('../proxy/httpClient');

const router = express.Router();

const HOP_BY_HOP_RES_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'content-encoding', // axios decodes for us if responseType isn't stream; with stream we pass through but reusing the header is unsafe
]);

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

  // Build outbound headers. Skip hop-by-hop and host headers; replace auth.
  const outHeaders = {
    Authorization: `Bearer ${config.upstream.apiKey}`,
  };
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'authorization' || lk === 'content-length') continue;
    if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding') continue;
    outHeaders[k] = v;
  }

  // For JSON, send the parsed body. For everything else (multipart, raw),
  // pipe the original request stream so binary uploads work.
  const data = isJson ? (req.body && Object.keys(req.body).length ? req.body : undefined) : req;

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

    res.status(upstream.status);
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP_RES_HEADERS.has(k.toLowerCase())) continue;
      res.setHeader(k, v);
    }

    upstream.data.on('error', err => {
      console.error('[passthrough] upstream stream error:', err.message);
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
