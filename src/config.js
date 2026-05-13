require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  proxyApiKey: process.env.PROXY_API_KEY || '',
  upstream: {
    baseUrl: (process.env.UPSTREAM_BASE_URL || 'https://api.openai.com').replace(/\/$/, ''),
    apiKey: process.env.UPSTREAM_API_KEY || '',
    provider: process.env.UPSTREAM_PROVIDER || 'openai',
    timeout: parseInt(process.env.REQUEST_TIMEOUT || '120000', 10),
  },
  defaultModel: process.env.DEFAULT_MODEL || 'gpt-4o',
  allowedModels: process.env.ALLOWED_MODELS
    ? process.env.ALLOWED_MODELS.split(',').map(m => m.trim()).filter(Boolean)
    : [],
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigins: process.env.CORS_ORIGINS || '*',
  localModels: (() => {
    if (!process.env.LOCAL_MODELS) return [];
    try {
      const parsed = JSON.parse(process.env.LOCAL_MODELS);
      if (!Array.isArray(parsed)) {
        console.warn('LOCAL_MODELS must be a JSON array — ignoring');
        return [];
      }
      return parsed.filter(m => typeof m === 'string');
    } catch (e) {
      console.warn(`LOCAL_MODELS is not valid JSON (${e.message}) — ignoring`);
      return [];
    }
  })(),
};
