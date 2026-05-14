const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logApp } = require('./logStore');

const DATA_FILE = path.join(__dirname, '..', 'data', 'rules.json');

// Hard limits to prevent memory abuse and ReDoS.
const MAX_PATTERN_LEN = 500;
const MAX_RESPONSE_LEN = 10_000;
const MAX_NAME_LEN = 200;
const MAX_DELAY_MS = 60_000;
// Prompt text is capped before regex matching to limit ReDoS exposure.
const MAX_MATCH_TEXT_LEN = 10_000;

let rules = [];

function loadRules() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      rules = JSON.parse(raw);
      logApp('rules_loaded', { count: rules.length, file: DATA_FILE });
    } else {
      logApp('rules_loaded', { count: 0, file: DATA_FILE, note: 'file not found, starting empty' });
    }
  } catch (err) {
    console.error('[staticRules] Failed to load rules:', err.message);
    logApp('rules_load_error', { error: err.message, file: DATA_FILE });
    rules = [];
  }
}

function saveRules() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(rules, null, 2));
  } catch (err) {
    console.error('[staticRules] Failed to save rules:', err.message);
  }
}

// Validate a regex pattern by compiling it; returns an error message or null.
function validateRegex(pattern) {
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (err) {
    return err.message;
  }
}

function validateRule(rule) {
  if (!rule.pattern || typeof rule.pattern !== 'string') throw new Error('pattern is required');
  if (!rule.response || typeof rule.response !== 'string') throw new Error('response is required');
  if (rule.pattern.length > MAX_PATTERN_LEN)
    throw new Error(`pattern must be ${MAX_PATTERN_LEN} characters or fewer`);
  if (rule.response.length > MAX_RESPONSE_LEN)
    throw new Error(`response must be ${MAX_RESPONSE_LEN} characters or fewer`);
  if (rule.name && rule.name.length > MAX_NAME_LEN)
    throw new Error(`name must be ${MAX_NAME_LEN} characters or fewer`);
  const matchType = rule.matchType || 'contains';
  if (matchType === 'regex') {
    const regexErr = validateRegex(rule.pattern);
    if (regexErr) throw new Error(`invalid regex pattern: ${regexErr}`);
  }
  if (rule.delayMs !== undefined && rule.delayMs !== null && rule.delayMs !== '') {
    const n = Number(rule.delayMs);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_DELAY_MS) {
      throw new Error(`delayMs must be an integer between 0 and ${MAX_DELAY_MS}`);
    }
  }
}

function coerceDelayMs(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function list() {
  return rules;
}

function get(id) {
  return rules.find(r => r.id === id) || null;
}

function add(rule) {
  validateRule(rule);
  const newRule = {
    id: crypto.randomUUID(),
    name: (rule.name || 'Untitled').slice(0, MAX_NAME_LEN),
    matchType: ['contains', 'exact', 'regex'].includes(rule.matchType) ? rule.matchType : 'contains',
    pattern: rule.pattern,
    response: rule.response,
    enabled: rule.enabled !== false,
    delayMs: coerceDelayMs(rule.delayMs),
    createdAt: new Date().toISOString(),
  };
  rules.push(newRule);
  saveRules();
  logApp('rule_added', { id: newRule.id, name: newRule.name, matchType: newRule.matchType, pattern: newRule.pattern });
  return newRule;
}

function update(id, updates) {
  const idx = rules.findIndex(r => r.id === id);
  if (idx === -1) return null;

  // Build the merged rule for validation before committing.
  const merged = { ...rules[idx], ...updates };
  // Only validate fields that were actually changed to keep toggle-only updates cheap.
  const changed = Object.keys(updates);
  if (changed.some(k => ['pattern', 'response', 'matchType', 'name', 'delayMs'].includes(k))) {
    validateRule(merged);
  }

  const allowed = ['name', 'matchType', 'pattern', 'response', 'enabled', 'delayMs'];
  const patch = {};
  for (const key of allowed) {
    if (key in updates) patch[key] = updates[key];
  }
  if (patch.matchType && !['contains', 'exact', 'regex'].includes(patch.matchType)) {
    delete patch.matchType;
  }
  if ('delayMs' in patch) patch.delayMs = coerceDelayMs(patch.delayMs);
  rules[idx] = { ...rules[idx], ...patch };
  saveRules();
  logApp('rule_updated', { id: rules[idx].id, name: rules[idx].name, changes: Object.keys(patch) });
  return rules[idx];
}

function remove(id) {
  const idx = rules.findIndex(r => r.id === id);
  if (idx === -1) return false;
  const removed = rules[idx];
  rules.splice(idx, 1);
  saveRules();
  logApp('rule_removed', { id: removed.id, name: removed.name });
  return true;
}

// n8n's AI Agent serializes its prompt as a JSON-fragment string:
//     "prompt": "<the user's actual text>"
// We unwrap so rules match against the real prompt, not the wrapper.
// Disable with UNWRAP_N8N_PROMPT=false in the environment.
const N8N_PROMPT_WRAPPER = /^\s*"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"\s*$/;
const UNWRAP_N8N = process.env.UNWRAP_N8N_PROMPT !== 'false';
function unwrapN8nPrompt(text) {
  if (!UNWRAP_N8N || typeof text !== 'string') return text;
  const m = text.match(N8N_PROMPT_WRAPPER);
  if (!m) return text;
  try { return JSON.parse('"' + m[1] + '"'); }
  catch { return m[1]; }
}

// Extract a single prompt string from the request body regardless of API format.
function extractPromptText(body) {
  if (!body) return '';

  // /v1/chat/completions — only consider user / system messages so rules
  // don't match on the assistant's prior outputs in a multi-turn chat.
  if (Array.isArray(body.messages)) {
    return body.messages
      .filter(m => m.role === 'user' || m.role === 'system')
      .map(m => {
        if (typeof m.content === 'string') return unwrapN8nPrompt(m.content);
        if (Array.isArray(m.content)) {
          return m.content.filter(c => c.type === 'text').map(c => unwrapN8nPrompt(c.text)).join(' ');
        }
        return '';
      }).join('\n');
  }

  // /v1/completions (legacy)
  if (typeof body.prompt === 'string') return unwrapN8nPrompt(body.prompt);
  if (Array.isArray(body.prompt)) return body.prompt.map(unwrapN8nPrompt).join('\n');

  // /v1/responses — skip assistant outputs in conversation history.
  if (typeof body.input === 'string') return unwrapN8nPrompt(body.input);
  if (Array.isArray(body.input)) {
    return body.input.map(item => {
      if (typeof item === 'string') return unwrapN8nPrompt(item);
      if (item.type === 'message') {
        if (item.role && item.role !== 'user' && item.role !== 'system') return '';
        // content may be a plain string (n8n, OpenAI SDK simple form) or an array of parts
        if (typeof item.content === 'string') return unwrapN8nPrompt(item.content);
        if (Array.isArray(item.content)) {
          return item.content
            .filter(c => c.type === 'input_text' || c.type === 'text' || typeof c.text === 'string')
            .map(c => unwrapN8nPrompt(c.text))
            .join(' ');
        }
      }
      return '';
    }).join('\n');
  }

  return '';
}

// Return the first enabled rule that matches the prompt, or null.
function match(promptText) {
  if (!promptText) return null;

  // Cap text length to limit ReDoS exposure from user-controlled prompts fed into regex rules.
  const text = promptText.slice(0, MAX_MATCH_TEXT_LEN);
  const lower = text.toLowerCase();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    try {
      switch (rule.matchType) {
        case 'exact':
          if (text.trim() === rule.pattern.trim()) return rule;
          break;
        case 'regex':
          if (new RegExp(rule.pattern, 'i').test(text)) return rule;
          break;
        case 'contains':
        default:
          if (lower.includes(rule.pattern.toLowerCase())) return rule;
          break;
      }
    } catch (err) {
      // Regex in a saved rule became invalid (e.g. after manual file edit) — skip and warn.
      console.warn(`[staticRules] Skipping rule "${rule.name}" (${rule.id}): invalid regex — ${err.message}`);
    }
  }

  return null;
}

loadRules();

module.exports = { list, get, add, update, remove, extractPromptText, match };
