// In-memory ring buffer for recent requests/responses/errors, with JSONL
// persistence to data/ so logs and app events survive container restarts.
// Writes are async-serialised per-file to avoid blocking the event loop on
// the hot response-finish path.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = parseInt(process.env.LOG_BUFFER_SIZE || '500', 10);
const MAX_APP_EVENTS = 200;
const MAX_LOG_FILE_BYTES = parseInt(process.env.LOG_FILE_MAX_BYTES || String(100 * 1024 * 1024), 10);

const DATA_DIR = path.join(__dirname, '..', 'data');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.log.jsonl');
const APP_EVENTS_FILE = path.join(DATA_DIR, 'app-events.log.jsonl');

const state = {
  entries: [],
  nextId: 1,
  startedAt: Date.now(),
  totals: { requests: 0, errors: 0, streaming: 0, bytesIn: 0, bytesOut: 0 },
  subscribers: new Set(),
  appEvents: [],
};

// ── Persistence ──────────────────────────────────────────────────────────────

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[logStore] failed to create data dir:', err.message);
  }
}

async function maybeRotate(file) {
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size <= MAX_LOG_FILE_BYTES) return;
    const old = file + '.1';
    try { await fs.promises.unlink(old); } catch { /* may not exist */ }
    await fs.promises.rename(file, old);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[logStore] rotation failed:', err.message);
    }
  }
}

// One async chain per file ensures writes stay ordered and rotation can't
// race with appends — but writes never block the event loop.
const writeChains = { [REQUESTS_FILE]: Promise.resolve(), [APP_EVENTS_FILE]: Promise.resolve() };
let appendErrorWarned = false;

function appendLine(file, obj) {
  writeChains[file] = writeChains[file].then(async () => {
    try {
      await maybeRotate(file);
      await fs.promises.appendFile(file, JSON.stringify(obj) + '\n');
    } catch (err) {
      if (!appendErrorWarned) {
        console.error('[logStore] failed to persist log:', err.message);
        appendErrorWarned = true;
      }
    }
  });
}

// Read the last N JSON-parseable lines from a JSONL file by scanning from the
// end in 64 KB chunks — bounds memory regardless of file size.
function readLastLinesSync(file, n) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('[logStore] failed to open log file:', err.message);
    return [];
  }
  try {
    const CHUNK = 64 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = fs.fstatSync(fd).size;
    let remainder = '';
    const lines = [];
    while (pos > 0 && lines.length < n) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      fs.readSync(fd, buf, 0, readSize, pos);
      const text = buf.toString('utf8', 0, readSize) + remainder;
      const parts = text.split('\n');
      remainder = parts.shift();
      for (let i = parts.length - 1; i >= 0 && lines.length < n; i--) {
        if (!parts[i]) continue;
        try { lines.push(JSON.parse(parts[i])); } catch { /* skip malformed */ }
      }
    }
    if (remainder && lines.length < n) {
      try { lines.push(JSON.parse(remainder)); } catch { /* skip */ }
    }
    return lines.reverse();
  } catch (err) {
    console.error('[logStore] failed to read log file:', err.message);
    return [];
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function loadPersistedState() {
  ensureDataDir();

  const entries = readLastLinesSync(REQUESTS_FILE, MAX_ENTRIES);
  for (const e of entries) {
    state.entries.push(e);
    if (typeof e.id === 'number' && e.id >= state.nextId) state.nextId = e.id + 1;
    state.totals.requests += 1;
    if (e.error || (e.status && e.status >= 400)) state.totals.errors += 1;
    if (e.stream) state.totals.streaming += 1;
    state.totals.bytesIn += e.bytesIn || 0;
    state.totals.bytesOut += e.bytesOut || 0;
  }

  state.appEvents.push(...readLastLinesSync(APP_EVENTS_FILE, MAX_APP_EVENTS));
}

// ── Public API ───────────────────────────────────────────────────────────────

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
    try { fn(entry); } catch { /* ignore subscriber errors */ }
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
