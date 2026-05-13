const express = require('express');
const { forwardRequest } = require('../proxy/forwarder');
const gemini = require('../providers/gemini');
const config = require('../config');

const router = express.Router();

function buildLocalModelList(ids) {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: ids.map(id => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'proxy',
    })),
  };
}

function applyAllowList(list) {
  if (config.allowedModels.length === 0 || !list?.data) return list;
  return { ...list, data: list.data.filter(m => config.allowedModels.includes(m.id)) };
}

router.get('/', async (req, res) => {
  if (config.localModels.length > 0) {
    return res.json(buildLocalModelList(config.localModels));
  }

  try {
    if (config.upstream.provider === 'gemini') {
      const result = await gemini.listModels();
      return res.status(result.status).json(applyAllowList(result.data));
    }

    const upstream = await forwardRequest('/v1/models', 'GET', null, req.headers);
    if (upstream.status !== 200) {
      return res.status(upstream.status).json(upstream.data);
    }
    res.json(applyAllowList(upstream.data));
  } catch (err) {
    console.error('[models] upstream error:', err.message);
    res.status(502).json({
      error: { message: 'Upstream error: ' + err.message, type: 'proxy_error' },
    });
  }
});

router.get('/:model', async (req, res) => {
  const modelId = req.params.model;

  if (config.localModels.length > 0) {
    if (!config.localModels.includes(modelId)) {
      return res.status(404).json({
        error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error' },
      });
    }
    return res.json({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'proxy',
    });
  }

  try {
    if (config.upstream.provider === 'gemini') {
      // Look up from the full list (Gemini's per-model endpoint exists but the
      // list is small and already cached client-side in most uses).
      const result = await gemini.listModels();
      if (result.status !== 200) return res.status(result.status).json(result.data);
      const found = (result.data.data || []).find(m => m.id === modelId);
      if (!found) {
        return res.status(404).json({
          error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error' },
        });
      }
      return res.json(found);
    }

    const upstream = await forwardRequest(`/v1/models/${modelId}`, 'GET', null, req.headers);
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    console.error('[models/:model] upstream error:', err.message);
    res.status(502).json({
      error: { message: 'Upstream error: ' + err.message, type: 'proxy_error' },
    });
  }
});

module.exports = router;
