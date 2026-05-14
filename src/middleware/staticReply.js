const staticRules = require('../staticRules');

// /v1/chat/completions — chat format
function buildChatResponse(rule, body) {
  const model = body.model || 'static';
  const id = 'chatcmpl-static-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: rule.response }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// /v1/completions — legacy text completion format
function buildCompletionsResponse(rule, body) {
  const model = body.model || 'static';
  const id = 'cmpl-static-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'text_completion',
    created,
    model,
    choices: [{ text: rule.response, index: 0, logprobs: null, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// /v1/responses — Responses API format
function buildResponsesApiResponse(rule, body) {
  const model = body.model || 'static';
  const created = Math.floor(Date.now() / 1000);
  return {
    id: 'resp-static-' + Date.now(),
    object: 'response',
    created_at: created,
    model,
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: rule.response }] }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function sendChatStreamResponse(rule, body, res) {
  const model = body.model || 'static';
  const id = 'chatcmpl-static-' + Date.now();
  const created = Math.floor(Date.now() / 1000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const chunks = [
    { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: rule.response }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendCompletionsStreamResponse(rule, body, res) {
  const model = body.model || 'static';
  const id = 'cmpl-static-' + Date.now();
  const created = Math.floor(Date.now() / 1000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const chunks = [
    { id, object: 'text_completion', created, model, choices: [{ text: rule.response, index: 0, logprobs: null, finish_reason: null }] },
    { id, object: 'text_completion', created, model, choices: [{ text: '', index: 0, logprobs: null, finish_reason: 'stop' }] },
  ];
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// /v1/responses streaming — emit Responses API semantic events
function sendResponsesStreamResponse(rule, body, res) {
  const model = body.model || 'static';
  const respId = 'resp-static-' + Date.now();
  const msgId  = 'msg-static-'  + Date.now();
  const created = Math.floor(Date.now() / 1000);
  let seq = 0;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function send(type, payload) {
    seq += 1;
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ type, sequence_number: seq, ...payload })}\n\n`);
  }

  const baseResp = {
    id: respId, object: 'response', created_at: created, model,
    status: 'in_progress', output: [], output_text: '',
    usage: null, incomplete_details: null,
  };

  send('response.created',  { response: { ...baseResp } });
  send('response.in_progress', { response: { ...baseResp } });
  send('response.output_item.added', {
    output_index: 0,
    item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
  });
  send('response.content_part.added', {
    item_id: msgId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  send('response.output_text.delta', {
    item_id: msgId, output_index: 0, content_index: 0, delta: rule.response,
  });
  send('response.output_text.done', {
    item_id: msgId, output_index: 0, content_index: 0, text: rule.response,
  });
  send('response.content_part.done', {
    item_id: msgId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: rule.response, annotations: [] },
  });
  send('response.output_item.done', {
    output_index: 0,
    item: {
      type: 'message', id: msgId, status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: rule.response, annotations: [] }],
    },
  });
  send('response.completed', {
    response: {
      ...baseResp,
      status: 'completed',
      output: [{
        type: 'message', id: msgId, status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: rule.response, annotations: [] }],
      }],
      output_text: rule.response,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  res.end();
}

module.exports = function staticReplyMiddleware(req, res, next) {
  const body = req.body || {};
  const promptText = staticRules.extractPromptText(body);
  const allRules = staticRules.list();

  req.trace?.('static_reply_check', {
    promptSnippet: promptText.slice(0, 200) || '(empty)',
    enabledRules: allRules.filter(r => r.enabled).length,
    totalRules: allRules.length,
  });

  const matchedRule = staticRules.match(promptText);

  if (!matchedRule) {
    req.trace?.('static_reply', { result: 'no_match' });
    return next();
  }

  req.trace?.('static_reply', {
    result: 'match',
    ruleId: matchedRule.id,
    ruleName: matchedRule.name,
    matchType: matchedRule.matchType,
    pattern: matchedRule.pattern,
    delayMs: matchedRule.delayMs || 0,
  });

  const isResponsesApi       = body.input !== undefined;
  const isLegacyCompletions  = !isResponsesApi && body.prompt !== undefined && body.messages === undefined;
  const format               = isResponsesApi ? 'responses' : isLegacyCompletions ? 'completions' : 'chat';

  let action;
  if (body.stream) {
    if (isResponsesApi)      action = () => sendResponsesStreamResponse(matchedRule, body, res);
    else if (isLegacyCompletions) action = () => sendCompletionsStreamResponse(matchedRule, body, res);
    else                     action = () => sendChatStreamResponse(matchedRule, body, res);
  } else {
    if (isResponsesApi)      action = () => res.json(buildResponsesApiResponse(matchedRule, body));
    else if (isLegacyCompletions) action = () => res.json(buildCompletionsResponse(matchedRule, body));
    else                     action = () => res.json(buildChatResponse(matchedRule, body));
  }

  const mode = body.stream ? 'stream' : 'json';
  const delay = Number(matchedRule.delayMs) || 0;

  if (delay <= 0) {
    req.trace?.('static_reply_respond', { mode, format });
    return action();
  }

  req.trace?.('static_reply_delay_start', { mode, format, delayMs: delay });
  const timer = setTimeout(() => {
    // Use destroyed/writableEnded since req.aborted is deprecated on Node 18+
    // and can race with a 'close' event already in flight.
    if (req.destroyed || res.destroyed || res.writableEnded) {
      req.trace?.('static_reply_delay_aborted', { delayMs: delay });
      return;
    }
    req.trace?.('static_reply_respond', { mode, format, delayMs: delay });
    try { action(); } catch (err) {
      req.trace?.('static_reply_error', { error: err.message });
    }
  }, delay);
  const onClose = () => clearTimeout(timer);
  req.on('close', onClose);
  res.on('finish', () => req.off('close', onClose));
};
