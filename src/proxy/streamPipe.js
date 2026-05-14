// Pipe an upstream axios stream response to an Express response as SSE.
// Captures the first ~4 KB of the response body into the request's log entry,
// emits a synthetic error frame on mid-stream failure so clients see a real
// terminator instead of a silent truncation.

const CAPTURE_LIMIT = 4096;

module.exports = function pipeStream(upstream, req, res, label) {
  res.status(upstream.status);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  req.trace?.('stream_pipe_start', { label, status: upstream.status });

  const entry = req._proxyEntry;
  let captured = '';
  let bytes = 0;

  const upstreamStream = upstream.data;

  upstreamStream.on('data', chunk => {
    bytes += chunk.length;
    if (captured.length < CAPTURE_LIMIT) {
      const room = CAPTURE_LIMIT - captured.length;
      captured += chunk.toString('utf8', 0, Math.min(chunk.length, room));
    }
  });

  upstreamStream.on('error', err => {
    console.error(`[${label}] upstream stream error:`, err.message);
    req.setError?.(`stream error: ${err.message}`);
    req.trace?.('stream_pipe_error', { label, error: err.message });
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: 'upstream connection lost: ' + err.message, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch { /* socket may already be gone */ }
      res.end();
    }
  });

  upstreamStream.on('end', () => {
    if (entry) {
      entry.responseBody = captured + (bytes > captured.length ? `… (${bytes - captured.length} more bytes streamed)` : '');
    }
    req.trace?.('stream_pipe_done', { label, bytes });
  });

  req.on('close', () => {
    if (!upstreamStream.destroyed) {
      req.trace?.('stream_pipe_client_disconnect', { label });
      upstreamStream.destroy();
    }
  });

  upstreamStream.pipe(res);
};
