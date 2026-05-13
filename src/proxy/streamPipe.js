// Pipe an upstream axios stream response to an Express response as SSE.
// Handles client disconnect, upstream errors, and avoids manual Transfer-Encoding.
module.exports = function pipeStream(upstream, req, res, label) {
  res.status(upstream.status);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const upstreamStream = upstream.data;

  upstreamStream.on('error', err => {
    console.error(`[${label}] upstream stream error:`, err.message);
    if (!res.writableEnded) res.end();
  });

  // If the client disconnects, tear down the upstream stream.
  req.on('close', () => {
    if (!upstreamStream.destroyed) upstreamStream.destroy();
  });

  upstreamStream.pipe(res);
};
