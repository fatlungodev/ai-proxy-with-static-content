// OpenAI Responses API (/v1/responses) — newer alternative to /chat/completions
// used by n8n's AI Agent and the official OpenAI SDK >=1.x with `responses.create()`.

const express = require('express');
const { forwardRequest } = require('../proxy/forwarder');
const pipeStream = require('../proxy/streamPipe');
const gemini = require('../providers/gemini');
const config = require('../config');

const router = express.Router();

// POST /v1/responses — create a response
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };

    if (!body.model) body.model = config.defaultModel;

    if (config.allowedModels.length > 0 && !config.allowedModels.includes(body.model)) {
      return res.status(400).json({
        error: {
          message: `Model '${body.model}' is not available through this proxy.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
    }

    if (config.upstream.provider === 'gemini') {
      const result = await gemini.responses(body);
      if (result.stream) return gemini.pipeResponsesStream(result, req, res);
      return res.status(result.status).json(result.data);
    }

    const upstream = await forwardRequest('/v1/responses', 'POST', body, req.headers);
    if (body.stream && !upstream.streamFailed) {
      return pipeStream(upstream, req, res, 'responses');
    }
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    console.error('[responses] upstream error:', err.message);
    res.status(502).json({
      error: { message: 'Upstream error: ' + err.message, type: 'proxy_error' },
    });
  }
});

// Passthrough for the remaining CRUD endpoints (OpenAI-compatible backends only).
// Gemini has no equivalent — returns 501.
async function geminiUnsupported(_req, res) {
  return res.status(501).json({
    error: {
      message: 'This endpoint is not supported when UPSTREAM_PROVIDER=gemini.',
      type: 'not_implemented',
    },
  });
}

async function passthrough(req, res, method) {
  if (config.upstream.provider === 'gemini') return geminiUnsupported(req, res);
  try {
    const path = req.originalUrl.split('?')[0]; // /v1/responses/...
    const upstream = await forwardRequest(path, method, method === 'GET' ? null : req.body, req.headers);
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    console.error(`[responses ${method}] upstream error:`, err.message);
    res.status(502).json({
      error: { message: 'Upstream error: ' + err.message, type: 'proxy_error' },
    });
  }
}

router.get('/:id',                 (req, res) => passthrough(req, res, 'GET'));
router.delete('/:id',              (req, res) => passthrough(req, res, 'DELETE'));
router.post('/:id/cancel',         (req, res) => passthrough(req, res, 'POST'));
router.get('/:id/input_items',     (req, res) => passthrough(req, res, 'GET'));

module.exports = router;
