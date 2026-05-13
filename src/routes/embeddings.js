const express = require('express');
const { forwardRequest } = require('../proxy/forwarder');
const gemini = require('../providers/gemini');
const config = require('../config');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };

    if (!body.model) {
      return res.status(400).json({
        error: {
          message: "Missing required field: 'model' (embedding models differ from chat models — specify one, e.g. text-embedding-3-small or text-embedding-004).",
          type: 'invalid_request_error',
          code: 'missing_model',
        },
      });
    }

    if (config.upstream.provider === 'gemini') {
      const result = await gemini.embeddings(body);
      return res.status(result.status).json(result.data);
    }

    const upstream = await forwardRequest('/v1/embeddings', 'POST', body, req.headers, req);
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    console.error('[embeddings] upstream error:', err.message);
    res.status(502).json({
      error: { message: 'Upstream error: ' + err.message, type: 'proxy_error' },
    });
  }
});

module.exports = router;
