'use strict';

/**
 * Hardened Node.js HTTP server (dependency-free, Node >= 18).
 * Addresses: error handling, graceful shutdown, input validation,
 * resource cleanup, and robust HTTP request processing.
 */

const http = require('http');
const os = require('os');

// --- Configuration (environment-overridable, safe defaults) ---
function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const config = {
  port: toInt(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  maxBodyBytes: toInt(process.env.MAX_BODY_BYTES, 1048576),
  requestTimeoutMs: toInt(process.env.REQUEST_TIMEOUT_MS, 30000),
  headersTimeoutMs: toInt(process.env.HEADERS_TIMEOUT_MS, 10000),
  keepAliveTimeoutMs: toInt(process.env.KEEPALIVE_TIMEOUT_MS, 5000),
  shutdownGraceMs: toInt(process.env.SHUTDOWN_GRACE_MS, 10000),
};

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

// --- Structured JSON logger ---
function logLine(stream, level, message, fields) {
  const record = Object.assign(
    { timestamp: new Date().toISOString(), level, message },
    fields || {}
  );
  try {
    stream.write(JSON.stringify(record) + '\n');
  } catch (_) {
    stream.write('{"level":"error","message":"log serialization failed"}\n');
  }
}
const log = {
  info: (m, f) => logLine(process.stdout, 'info', m, f),
  warn: (m, f) => logLine(process.stdout, 'warn', m, f),
  error: (m, f) => logLine(process.stderr, 'error', m, f),
};

// --- Centralized JSON responder (never leaks stack traces) ---
function sendJson(res, statusCode, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  if (res.req && res.req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
}

const STATUS_MESSAGES = {
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function sendError(res, statusCode, detail) {
  sendJson(res, statusCode, {
    error: STATUS_MESSAGES[statusCode] || 'Error',
    status: statusCode,
    detail: detail || undefined,
  });
}

// --- Streamed body reader with byte cap and early abort ---
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    }
    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        cleanup();
        const err = new Error('Payload Too Large');
        err.statusCode = 413;
        reject(err); // caller sends 413, THEN aborts the stream
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    function onError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function onAborted() {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error('Client Aborted');
      err.aborted = true;
      reject(err);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

// --- Route handlers ---
function handleHealth(req, res) {
  sendJson(res, 200, {
    status: shuttingDown ? 'draining' : 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    host: os.hostname(),
    timestamp: new Date().toISOString(),
  });
}

async function handleEcho(req, res) {
  const ctype = (req.headers['content-type'] || '')
    .split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') {
    return sendError(res, 415, 'Content-Type must be application/json');
  }
  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (err) {
    if (err.statusCode === 413) {
      res.setHeader('Connection', 'close');
      sendError(res, 413, 'Body exceeds maximum allowed size');
      res.on('finish', () => req.destroy()); // abort upload after flush
      return;
    }
    if (err.aborted) return; // client went away; nothing to send
    throw err;
  }
  let parsed;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch (_) {
    return sendError(res, 400, 'Malformed JSON body');
  }
  sendJson(res, 200, { received: parsed });
}

// --- Request dispatcher ---
async function dispatch(req, res) {
  if (shuttingDown) {
    res.setHeader('Connection', 'close');
    return sendError(res, 503, 'Server is shutting down');
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    res.setHeader('Allow', Array.from(ALLOWED_METHODS).join(', '));
    return sendError(res, 405, `Method ${req.method} not allowed`);
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return sendError(res, 400, 'Invalid request URL');
  }
  const pathname = parsedUrl.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (pathname === '/health' || pathname === '/healthz' || pathname === '/readyz')) {
    return handleHealth(req, res);
  }
  if (req.method === 'POST' && pathname === '/echo') {
    return handleEcho(req, res);
  }
  return sendError(res, 404, 'Resource not found');
}

function requestHandler(req, res) {
  if (req.socket) req.socket._idle = false;
  req.on('error', (err) => log.warn('request stream error', { error: err.message }));
  res.on('error', (err) => log.warn('response stream error', { error: err.message }));
  req.on('aborted', () => log.warn('request aborted by client', { url: req.url }));

  res.on('finish', () => {
    if (req.socket) req.socket._idle = true;
    if (shuttingDown && req.socket && !req.socket.destroyed) req.socket.end();
  });

  Promise.resolve()
    .then(() => dispatch(req, res))
    .catch((err) => {
      log.error('unhandled request error', { error: err.message, url: req.url });
      sendError(res, 500);
    });
}

// --- Server + socket registry ---
const server = http.createServer(requestHandler);
server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = config.headersTimeoutMs;
server.keepAliveTimeout = config.keepAliveTimeoutMs;
server.timeout = config.requestTimeoutMs;

const sockets = new Set();
server.on('connection', (socket) => {
  socket._idle = true;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error('address in use, cannot bind', { host: config.host, port: config.port });
    process.exit(1);
  } else if (err.code === 'EACCES') {
    log.error('permission denied binding port', { port: config.port });
    process.exit(1);
  } else {
    log.error('server error', { error: err.message, code: err.code });
  }
});

// --- Graceful shutdown coordinator ---
let shuttingDown = false;
let forceTimer = null;

function gracefulShutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown initiated', { signal });

  forceTimer = setTimeout(() => {
    log.error('grace period elapsed, forcing exit');
    for (const s of sockets) s.destroy();
    process.exit(1);
  }, config.shutdownGraceMs);
  if (forceTimer.unref) forceTimer.unref();

  server.close((err) => {
    if (forceTimer) clearTimeout(forceTimer);
    if (err) {
      log.error('error during server close', { error: err.message });
      process.exit(1);
    }
    log.info('server closed cleanly');
    process.exit(exitCode);
  });

  let destroyed = 0;
  for (const socket of sockets) {
    if (socket._idle) {
      socket.destroy();
      destroyed += 1;
    }
  }
  log.info('idle sockets destroyed', { count: destroyed, remaining: sockets.size });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) });
  gracefulShutdown('unhandledRejection', 1);
});

// --- Bootstrap ---
server.listen(config.port, config.host, () => {
  log.info('server listening', {
    host: config.host,
    port: config.port,
    pid: process.pid,
    nodeVersion: process.version,
  });
});

module.exports = { server, config };
