const crypto = require('crypto');

const COOKIE_NAME = '_aip_sess';

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

// Derive a stable, non-reversible session token from the password.
// Changing the password automatically invalidates all existing cookies.
function expectedToken(password) {
  return crypto.createHmac('sha256', password).update('ai-proxy-session-v1').digest('hex');
}

// Constant-time string comparison to prevent timing attacks.
// Handles mismatched lengths by comparing against itself first (still O(n)).
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // spend equivalent time
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthenticated(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  const legacyToken = process.env.DASHBOARD_TOKEN;

  // No protection configured → open access
  if (!password && !legacyToken) return true;

  // Bearer token or ?token= query param (for API clients / n8n)
  const provided = req.query.token ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (legacyToken && safeEqual(provided, legacyToken)) return true;
  if (password && safeEqual(provided, password)) return true;

  // Session cookie set by the login form
  if (password) {
    const cookies = parseCookies(req.headers.cookie || '');
    const cookieVal = cookies[COOKIE_NAME] || '';
    if (safeEqual(cookieVal, expectedToken(password))) return true;
  }

  return false;
}

// Express middleware for dashboard API routes — returns 401 JSON on failure.
// Browser redirect is handled separately in index.js for the HTML page.
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { isAuthenticated, expectedToken, parseCookies, requireAuth, safeEqual, COOKIE_NAME };
