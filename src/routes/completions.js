const express = require('express');
const { forwardRequest } = require('../proxy/forwarder');
const pipeStream = require('../proxy/streamPipe');
const config = require('../config');

const router = express.Router();

// Legacy text completions endpoint
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

    const upstream = await forwardRequest('/v1/completions', 'POST', body, req.headers);

    if (body.stream && !upstream.streamFailed) {
      return pipeStream(upstream, req, res, 'completions');
    }

    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    console.error('[completions] upstream error:', err.message);
    res.status(502).json({
      error: { message: 'Upstream error: ' + err.message, type: 'proxy_error' },
    });
  }
});

module.exports = router;
