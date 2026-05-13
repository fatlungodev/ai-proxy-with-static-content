// Gemini provider — translates OpenAI-shaped requests/responses to/from
// Google's Generative Language API (v1beta).
//
// Endpoints used:
//   GET  /v1beta/models
//   POST /v1beta/models/{model}:generateContent
//   POST /v1beta/models/{model}:streamGenerateContent?alt=sse
//   POST /v1beta/models/{model}:batchEmbedContents

const axios = require('axios');
const { randomUUID } = require('crypto');
const config = require('../config');
const { axiosProxyOptions } = require('../proxy/httpClient');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

function baseUrl() {
  // If user pointed UPSTREAM_BASE_URL at Google's host, use it; otherwise default.
  return config.upstream.baseUrl.includes('googleapis')
    ? config.upstream.baseUrl
    : DEFAULT_BASE;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': config.upstream.apiKey,
  };
}

const FINISH_MAP = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  OTHER: 'stop',
};

function translateError(geminiErr, fallbackMsg) {
  const msg = geminiErr?.error?.message || fallbackMsg || JSON.stringify(geminiErr);
  return {
    error: {
      message: msg,
      type: 'upstream_error',
      code: geminiErr?.error?.status || null,
    },
  };
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

// ----- /v1/models -----
async function listModels() {
  const url = `${baseUrl()}/v1beta/models`;
  const res = await axios.get(url, {
    headers: headers(),
    timeout: config.upstream.timeout,
    validateStatus: () => true,
    ...axiosProxyOptions(url),
  });

  if (res.status !== 200) {
    return { status: res.status, data: translateError(res.data, 'Failed to list Gemini models') };
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    status: 200,
    data: {
      object: 'list',
      data: (res.data.models || [])
        .filter(m => !m.supportedGenerationMethods ||
                     m.supportedGenerationMethods.includes('generateContent') ||
                     m.supportedGenerationMethods.includes('embedContent'))
        .map(m => ({
          id: (m.name || '').replace(/^models\//, ''),
          object: 'model',
          created: now,
          owned_by: 'google',
        })),
    },
  };
}

// ----- request translation: OpenAI → Gemini -----
function oaiMessagesToGemini(messages) {
  const contents = [];
  let systemInstruction = null;

  for (const m of messages || []) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content || []).map(p => p.text || '').join('');
      systemInstruction = { parts: [{ text }] };
      continue;
    }

    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof m.content === 'string') {
      parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') {
          parts.push({ text: p.text });
        } else if (p.type === 'image_url' && p.image_url?.url) {
          const dataMatch = p.image_url.url.match(/^data:(.+?);base64,(.+)$/);
          if (dataMatch) {
            parts.push({ inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } });
          } else {
            parts.push({ fileData: { fileUri: p.image_url.url } });
          }
        }
      }
    }

    if (parts.length) contents.push({ role, parts });
  }

  return { contents, systemInstruction };
}

function buildGenerationConfig(body) {
  const cfg = {};
  if (body.temperature != null) cfg.temperature = body.temperature;
  if (body.top_p != null) cfg.topP = body.top_p;
  if (body.max_tokens != null) cfg.maxOutputTokens = body.max_tokens;
  if (body.stop) cfg.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.response_format?.type === 'json_object') cfg.responseMimeType = 'application/json';
  return cfg;
}

function geminiCandidateToChoice(candidate, index = 0) {
  const text = (candidate?.content?.parts || [])
    .map(p => p.text || '')
    .join('');
  return {
    index,
    message: { role: 'assistant', content: text },
    finish_reason: FINISH_MAP[candidate?.finishReason] || null,
  };
}

function geminiUsageToOai(u) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.promptTokenCount || 0,
    completion_tokens: u.candidatesTokenCount || 0,
    total_tokens: u.totalTokenCount || 0,
  };
}

// ----- /v1/chat/completions -----
async function chatCompletions(body) {
  const model = body.model;
  if (!model) {
    return { status: 400, stream: false, data: translateError(null, "Missing 'model'") };
  }

  const { contents, systemInstruction } = oaiMessagesToGemini(body.messages || []);
  const generationConfig = buildGenerationConfig(body);

  const geminiBody = { contents };
  if (systemInstruction) geminiBody.systemInstruction = systemInstruction;
  if (Object.keys(generationConfig).length) geminiBody.generationConfig = generationConfig;

  const isStream = body.stream === true;
  const action = isStream ? 'streamGenerateContent' : 'generateContent';
  const qs = isStream ? '?alt=sse' : '';
  const url = `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:${action}${qs}`;

  const res = await axios.post(url, geminiBody, {
    headers: headers(),
    timeout: config.upstream.timeout,
    responseType: isStream ? 'stream' : 'json',
    validateStatus: () => true,
    ...axiosProxyOptions(url),
  });

  // Error path — even for stream requests, drain and return JSON.
  if (res.status >= 400) {
    let errPayload = res.data;
    if (isStream && errPayload && typeof errPayload.on === 'function') {
      const text = await readStream(errPayload);
      try { errPayload = JSON.parse(text); }
      catch { errPayload = { error: { message: text || 'Upstream error' } }; }
    }
    return { status: res.status, stream: false, data: translateError(errPayload) };
  }

  if (!isStream) {
    return {
      status: 200,
      stream: false,
      data: {
        id: 'chatcmpl-' + randomUUID(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: (res.data.candidates || []).map((c, i) => geminiCandidateToChoice(c, i)),
        usage: geminiUsageToOai(res.data.usageMetadata),
      },
    };
  }

  return { status: 200, stream: true, geminiStream: res.data, model };
}

// Pipe a Gemini SSE stream as OpenAI SSE chunks.
function pipeChatStream(result, req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const chatId = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const model = result.model;

  let buf = '';
  let firstChunk = true;
  let finalUsage = null;

  function emit(delta, finishReason) {
    const chunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  result.geminiStream.on('data', chunk => {
    buf += chunk.toString('utf8');
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);

      let payload = '';
      for (const line of event.split('\n')) {
        if (line.startsWith('data:')) payload += line.slice(5).trim();
      }
      if (!payload || payload === '[DONE]') continue;

      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }

      const candidate = obj.candidates?.[0];
      const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
      const finishReason = candidate?.finishReason ? (FINISH_MAP[candidate.finishReason] || null) : null;

      if (obj.usageMetadata) finalUsage = obj.usageMetadata;

      if (text || firstChunk) {
        const delta = firstChunk ? { role: 'assistant', content: text } : { content: text };
        firstChunk = false;
        emit(delta, null);
      }
      if (finishReason) emit({}, finishReason);
    }
  });

  result.geminiStream.on('end', () => {
    // Final empty chunk with usage (OpenAI emits this when stream_options.include_usage)
    if (finalUsage) {
      const finalChunk = {
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: geminiUsageToOai(finalUsage),
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });

  result.geminiStream.on('error', err => {
    console.error('[gemini stream]', err.message);
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    if (!result.geminiStream.destroyed) result.geminiStream.destroy();
  });
}

// ----- /v1/embeddings -----
async function embeddings(body) {
  const model = body.model;
  if (!model) {
    return { status: 400, data: translateError(null, "Missing 'model'") };
  }

  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const url = `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`;
  const geminiBody = {
    requests: inputs.map(text => ({
      model: `models/${model}`,
      content: { parts: [{ text: String(text) }] },
    })),
  };

  const res = await axios.post(url, geminiBody, {
    headers: headers(),
    timeout: config.upstream.timeout,
    validateStatus: () => true,
    ...axiosProxyOptions(url),
  });

  if (res.status >= 400) {
    return { status: res.status, data: translateError(res.data) };
  }

  return {
    status: 200,
    data: {
      object: 'list',
      data: (res.data.embeddings || []).map((e, i) => ({
        object: 'embedding',
        embedding: e.values,
        index: i,
      })),
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    },
  };
}

module.exports = { listModels, chatCompletions, pipeChatStream, embeddings };
