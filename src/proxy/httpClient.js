// Builds axios options that route requests through an HTTP/HTTPS proxy.
// Honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY env vars (standard convention).

const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const httpsProxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const httpProxyUrl  = process.env.HTTP_PROXY  || process.env.http_proxy  || '';
const noProxy       = (process.env.NO_PROXY || process.env.no_proxy || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const httpsAgent = httpsProxyUrl ? new HttpsProxyAgent(httpsProxyUrl) : undefined;
const httpAgent  = httpProxyUrl  ? new HttpProxyAgent(httpProxyUrl)   : undefined;

function shouldBypass(targetUrl) {
  if (noProxy.length === 0) return false;
  let host;
  try { host = new URL(targetUrl).hostname; } catch { return false; }
  return noProxy.some(rule => {
    if (rule === '*') return true;
    if (rule.startsWith('.')) return host.endsWith(rule) || host === rule.slice(1);
    return host === rule || host.endsWith('.' + rule);
  });
}

// Returns axios options to merge into a request. Disables axios's built-in
// `proxy` to keep agent-based routing as the single source of truth.
function axiosProxyOptions(targetUrl) {
  if (!httpsAgent && !httpAgent) return { proxy: false };
  if (shouldBypass(targetUrl)) return { proxy: false };
  return {
    httpAgent: httpAgent || httpsAgent,
    httpsAgent: httpsAgent || httpAgent,
    proxy: false,
  };
}

function describe() {
  if (!httpsAgent && !httpAgent) return 'direct (no outbound proxy)';
  const parts = [];
  if (httpsProxyUrl) parts.push(`HTTPS_PROXY=${redact(httpsProxyUrl)}`);
  if (httpProxyUrl)  parts.push(`HTTP_PROXY=${redact(httpProxyUrl)}`);
  if (noProxy.length) parts.push(`NO_PROXY=${noProxy.join(',')}`);
  return parts.join(' | ');
}

function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch { return url; }
}

module.exports = { axiosProxyOptions, describe };
