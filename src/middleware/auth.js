const config = require('../config');

module.exports = function auth(req, res, next) {
  if (!config.proxyApiKey) {
    req.trace?.('auth', { result: 'skip', reason: 'no PROXY_API_KEY configured' });
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (token !== config.proxyApiKey) {
    req.trace?.('auth', { result: 'fail', reason: 'invalid API key' });
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
  }

  req.trace?.('auth', { result: 'pass' });
  next();
};
