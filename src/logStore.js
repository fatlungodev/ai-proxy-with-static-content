// In-memory ring buffer for recent requests/responses/errors.
// Also exposes a simple pub/sub for live streaming to the dashboard.

const MAX_ENTRIES = parseInt(process.env.LOG_BUFFER_SIZE || '500', 10);
const MAX_APP_EVENTS = 200;

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
  if (process.env.LOG_LEVEL === 'debug') {
    console.log(`[app:${type}]`, data);
  }
}

function getAppEvents() {
  return [...state.appEvents];
}

module.exports = { add, list, status, subscribe, logApp, getAppEvents };
