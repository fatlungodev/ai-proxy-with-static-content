const config = require('../config');

module.exports = function auth(req, res, next) {
  // Skip auth if no proxy key is configured
  if (!config.proxyApiKey) return next();

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (token !== config.proxyApiKey) {
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
  }

  next();
};
