// In-memory ring buffer for recent requests/responses/errors, with JSONL
// persistence to data/ so logs and app events survive container restarts.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = parseInt(process.env.LOG_BUFFER_SIZE || '500', 10);
const MAX_APP_EVENTS = 200;
const MAX_LOG_FILE_BYTES = parseInt(process.env.LOG_FILE_MAX_BYTES || String(100 * 1024 * 1024), 10);

const DATA_DIR = path.join(__dirname, '..', 'data');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.log.jsonl');
const APP_EVENTS_FILE = path.join(DATA_DIR, 'app-events.log.jsonl');

const state = {
  entries: [],          // newest last
  nextId: 1,
  startedAt: Date.now(),
  totals: {
    requests: 0,
    errors: 0,
    streaming: 0,
    bytesIn: 0,
    bytesOut: 0,
  },
  subscribers: new Set(), // each is a function(entry)
  appEvents: [],          // application-level lifecycle events (startup, rule changes, errors)
};

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[logStore] failed to create data dir:', err.message);
  }
}

// Rotate <file> → <file>.1 when it exceeds the size cap. Keeps one rotated
// generation, so on-disk usage is bounded by ~2 × MAX_LOG_FILE_BYTES per file.
function rotateIfNeeded(file) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size <= MAX_LOG_FILE_BYTES) return;
    const old = file + '.1';
    try { fs.unlinkSync(old); } catch { /* ignore — may not exist */ }
    fs.renameSync(file, old);
  } catch (err) {
    console.error('[logStore] log rotation failed:', err.message);
  }
}

let appendErrorWarned = false;
function appendLine(file, obj) {
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (err) {
    if (!appendErrorWarned) {
      console.error('[logStore] failed to persist log:', err.message);
      appendErrorWarned = true;
    }
  }
}

function readLastLines(file, n) {
  if (!fs.existsSync(file)) return [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const out = [];
    // Walk from the end so we stop as soon as we have N valid entries.
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const line = lines[i];
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    return out.reverse();
  } catch (err) {
    console.error('[logStore] failed to read log file:', err.message);
    return [];
  }
}

function loadPersistedState() {
  ensureDataDir();

  const entries = readLastLines(REQUESTS_FILE, MAX_ENTRIES);
  for (const e of entries) {
    state.entries.push(e);
    if (typeof e.id === 'number' && e.id >= state.nextId) state.nextId = e.id + 1;
    state.totals.requests += 1;
    if (e.error || (e.status && e.status >= 400)) state.totals.errors += 1;
    if (e.stream) state.totals.streaming += 1;
    state.totals.bytesIn += e.bytesIn || 0;
    state.totals.bytesOut += e.bytesOut || 0;
  }

  state.appEvents.push(...readLastLines(APP_EVENTS_FILE, MAX_APP_EVENTS));
}

function add(entry) {
  entry.id = state.nextId++;
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }

  state.totals.requests += 1;
  if (entry.error || (entry.status && entry.status >= 400)) state.totals.errors += 1;
  if (entry.stream) state.totals.streaming += 1;
  state.totals.bytesIn += entry.bytesIn || 0;
  state.totals.bytesOut += entry.bytesOut || 0;

  appendLine(REQUESTS_FILE, entry);

  for (const fn of state.subscribers) {
    try { fn(entry); } catch (e) { /* ignore subscriber errors */ }
  }
}

function list({ limit = 100, sinceId = 0, level = null } = {}) {
  let rows = state.entries;
  if (sinceId) rows = rows.filter(e => e.id > sinceId);
  if (level === 'error') rows = rows.filter(e => e.error || (e.status && e.status >= 400));
  return rows.slice(-limit);
}

function status() {
  return {
    startedAt: state.startedAt,
    uptimeMs: Date.now() - state.startedAt,
    bufferSize: state.entries.length,
    maxBufferSize: MAX_ENTRIES,
    totals: { ...state.totals },
  };
}

function subscribe(fn) {
  state.subscribers.add(fn);
  return () => state.subscribers.delete(fn);
}

// Record an application-level event (not tied to a specific request).
function logApp(type, data = {}) {
  const event = { ts: new Date().toISOString(), type, ...data };
  state.appEvents.push(event);
  if (state.appEvents.length > MAX_APP_EVENTS) {
    state.appEvents.splice(0, state.appEvents.length - MAX_APP_EVENTS);
  }
  appendLine(APP_EVENTS_FILE, event);
  if (process.env.LOG_LEVEL === 'debug') {
    console.log(`[app:${type}]`, data);
  }
}

function getAppEvents() {
  return [...state.appEvents];
}

loadPersistedState();

module.exports = { add, list, status, subscribe, logApp, getAppEvents };
