const axios = require('axios');
const config = require('../config');
const { axiosProxyOptions } = require('./httpClient');

function buildUpstreamHeaders(originalHeaders) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.upstream.apiKey}`,
  };

  // Forward select headers from the client (including n8n / OpenAI SDK headers)
  const forward = [
    'x-request-id',
    'x-stainless-lang',
    'x-stainless-package-version',
    'openai-beta',
    'openai-organization',
    'openai-project',
  ];
  for (const h of forward) {
    if (originalHeaders[h]) headers[h] = originalHeaders[h];
  }

  // Anthropic-specific auth (note: schema translation is NOT performed —
  // OpenAI-shaped requests will fail against Anthropic's /v1/messages API)
  if (config.upstream.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = config.upstream.apiKey;
    delete headers.Authorization;
  }

  return headers;
}

function readStreamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// req is optional — pass it to attach trace events to the request log entry.
async function forwardRequest(path, method, body, reqHeaders, req) {
  const url = `${config.upstream.baseUrl}${path}`;
  const headers = buildUpstreamHeaders(reqHeaders);
  const isStream = body && body.stream === true;

  req?.trace?.('upstream_request', {
    url,
    method,
    model: body?.model || null,
    stream: isStream,
    provider: config.upstream.provider,
  });

  const t0 = Date.now();

  const response = await axios({
    method,
    url,
    data: body,
    headers,
    timeout: config.upstream.timeout,
    responseType: isStream ? 'stream' : 'json',
    validateStatus: () => true,
    ...axiosProxyOptions(url),
  });

  // If we asked for a stream but upstream returned an error, drain the stream
  // into a buffer and convert to JSON so the caller can return a real error.
  if (isStream && response.status >= 400) {
    const buf = await readStreamToBuffer(response.data);
    const text = buf.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { message: text || 'Upstream error', type: 'upstream_error' } };
    }
    response.data = parsed;
    response.streamFailed = true;
  }

  req?.trace?.('upstream_response', {
    status: response.status,
    durationMs: Date.now() - t0,
    streaming: isStream && !response.streamFailed,
    streamFailed: response.streamFailed || false,
  });

  return response;
}

module.exports = { forwardRequest };
