'use strict';

/**
 * Hardened Node.js HTTP server (dependency-free, Node >= 18).
 * Addresses: error handling, graceful shutdown, input validation,
 * resource cleanup, and robust HTTP request processing.
 */

const http = require('http');
const os = require('os');

// --- Configuration (environment-overridable, strictly validated) ---
// Upper bound for any millisecond timer: Node's setTimeout clamps delays above
// 2^31-1 ms to 1 ms and emits a TimeoutOverflowWarning, silently disabling the
// protection — so such values are rejected outright rather than accepted.
const MAX_TIMER_MS = 2147483647;

// Strict, full-string decimal integer parse. Unlike parseInt, this rejects
// trailing junk ("0junk"), exponent/hex forms, whitespace-only/empty strings,
// and any value that is not a safe integer. Returns the number or null.
function parseIntStrict(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// Collected during config construction; a non-empty list aborts startup.
const configErrors = [];

// Read an integer setting from the environment with setting-specific bounds:
//   - unset/empty            -> the (already valid) default, unchanged;
//   - supplied but invalid   -> record a descriptive error and keep the default
//     so we can report EVERY problem before failing fast and non-zero.
function readIntSetting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseIntStrict(raw);
  if (n === null) {
    configErrors.push(name + '="' + raw + '" is not a valid integer');
    return fallback;
  }
  if (n < min || n > max) {
    configErrors.push(name + '=' + n + ' is out of range [' + min + ', ' + max + ']');
    return fallback;
  }
  return n;
}

const config = {
  // Port 0 is intentionally permitted: it binds an ephemeral port (useful for
  // tests). The actual bound port is reported from server.address() at startup.
  port: readIntSetting('PORT', 3000, 0, 65535),
  host: process.env.HOST || '0.0.0.0',
  // Body cap must be at least 1 byte; the only ceiling is the safe-integer range.
  maxBodyBytes: readIntSetting('MAX_BODY_BYTES', 1048576, 1, Number.MAX_SAFE_INTEGER),
  // Timeouts/grace must be strictly positive — 0 would DISABLE the protection —
  // and within the timer ceiling to avoid overflow-to-1ms.
  requestTimeoutMs: readIntSetting('REQUEST_TIMEOUT_MS', 30000, 1, MAX_TIMER_MS),
  headersTimeoutMs: readIntSetting('HEADERS_TIMEOUT_MS', 10000, 1, MAX_TIMER_MS),
  keepAliveTimeoutMs: readIntSetting('KEEPALIVE_TIMEOUT_MS', 5000, 1, MAX_TIMER_MS),
  shutdownGraceMs: readIntSetting('SHUTDOWN_GRACE_MS', 10000, 1, MAX_TIMER_MS),
};

// Relationship invariant: headers must time out no later than the whole request,
// otherwise the headers timeout is meaningless. (Defaults satisfy 10000 <= 30000.)
if (config.headersTimeoutMs > config.requestTimeoutMs) {
  configErrors.push(
    'HEADERS_TIMEOUT_MS=' + config.headersTimeoutMs +
    ' must be <= REQUEST_TIMEOUT_MS=' + config.requestTimeoutMs
  );
}

// Fail fast and non-zero on ANY supplied invalid value so a misconfiguration can
// never silently disable a protection. logLine is a hoisted function declaration,
// so it is safe to call here even though `log` (a const) is defined later.
if (configErrors.length > 0) {
  logLine(process.stderr, 'error', 'invalid configuration; refusing to start', { errors: configErrors });
  process.exit(1);
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

// --- Safe helpers for the fatal / logging paths ---
// Produce an ISO timestamp without ever throwing (Date can, in theory, throw
// on an exotic Date subclass; the logger and fatal guards must never do so).
function safeTimestamp() {
  try {
    return new Date().toISOString();
  } catch (_) {
    return '1970-01-01T00:00:00.000Z';
  }
}

// Normalize ANY thrown or rejected value into a plain, safe descriptor without
// dereferencing untrusted getters or invoking custom string coercion. Handles
// Errors, primitives, null/undefined, and hostile objects. Never throws.
function describeThrown(value) {
  const out = { name: 'Unknown', message: 'unknown error' };
  try {
    if (value instanceof Error) {
      out.name = typeof value.name === 'string' ? value.name : 'Error';
      out.message = typeof value.message === 'string' ? value.message : '(no message)';
      if (typeof value.stack === 'string') out.stack = value.stack;
      return out;
    }
    const t = typeof value;
    if (value === null) { out.name = 'null'; out.message = 'null'; return out; }
    if (t === 'undefined') { out.name = 'undefined'; out.message = 'undefined'; return out; }
    if (t === 'string') { out.name = 'string'; out.message = value; return out; }
    if (t === 'number' || t === 'boolean' || t === 'bigint') {
      out.name = t;
      out.message = String(value); // primitives coerce safely, no custom hooks
      return out;
    }
    // object / function / symbol: use the built-in tag, which does NOT invoke
    // the value's own toString/valueOf getters.
    out.name = t;
    out.message = Object.prototype.toString.call(value);
    return out;
  } catch (_) {
    return { name: 'Unknown', message: 'unnormalizable error' };
  }
}

// --- Structured JSON logger (guaranteed non-throwing) ---
// Each stage — record construction, serialization, primary write, and fallback
// write — is wrapped in its own independent no-throw guard so that a hostile
// field value, a serialization failure, or a broken stream can never crash the
// process or trigger recursive fatal-guard failure.
function logLine(stream, level, message, fields) {
  let line = null;
  try {
    const record = { timestamp: safeTimestamp(), level, message };
    if (fields && typeof fields === 'object') {
      for (const key of Object.keys(fields)) {
        record[key] = fields[key];
      }
    }
    const serialized = JSON.stringify(record);
    // JSON.stringify can return undefined (e.g. for a lone symbol); guard it.
    if (typeof serialized === 'string') line = serialized + '\n';
  } catch (_) {
    line = null;
  }

  if (line === null) {
    // Constant, COMPLETE fallback schema (timestamp/level/message present).
    try {
      const fallback = JSON.stringify({
        timestamp: safeTimestamp(),
        level: 'error',
        message: 'log serialization failed',
      });
      line = (typeof fallback === 'string' ? fallback : '{"timestamp":"1970-01-01T00:00:00.000Z","level":"error","message":"log serialization failed"}') + '\n';
    } catch (_) {
      line = '{"timestamp":"1970-01-01T00:00:00.000Z","level":"error","message":"log serialization failed"}\n';
    }
  }

  // Primary write guard; on failure fall back to stderr, then give up silently.
  try {
    stream.write(line);
  } catch (_) {
    try {
      if (stream !== process.stderr) process.stderr.write(line);
    } catch (_) {
      // Nothing more we can safely do; the logger must never throw.
    }
  }
}
const log = {
  info: (m, f) => logLine(process.stdout, 'info', m, f),
  warn: (m, f) => logLine(process.stdout, 'warn', m, f),
  error: (m, f) => logLine(process.stderr, 'error', m, f),
};

// --- Centralized JSON responder (never leaks stack traces) ---
function sendJson(res, statusCode, payload) {
  // Guard against writing to a response that is already committed, ended, or
  // whose socket is gone; writing then would throw (ERR_STREAM_WRITE_AFTER_END
  // / ERR_HTTP_HEADERS_SENT) and cannot deliver anything to the client.
  if (res.headersSent || res.writableEnded || res.destroyed || res.writable === false) return;
  // Finding 7: any response produced once draining has begun must NOT advertise
  // keep-alive — including requests that arrived before the shutdown flag
  // flipped — so clients do not attempt to reuse a connection we are closing.
  if (shuttingDown) {
    try { res.setHeader('Connection', 'close'); } catch (_) { /* headers may be locked */ }
  }
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

// Extract a log-safe request path: pathname only, control characters stripped,
// length-capped. Query string, fragment, and userinfo — which can carry tokens,
// credentials, or PII — are discarded so they never reach the logs (Finding 6,
// CWE-532). Never throws.
function safePath(req) {
  try {
    const raw = (req && typeof req.url === 'string') ? req.url : '/';
    const u = new URL(raw, 'http://localhost');
    let p = u.pathname || '/';
    p = p.replace(/[\u0000-\u001f\u007f]/g, ''); // strip control chars
    if (p.length > 100) p = p.slice(0, 100) + '...';
    return p;
  } catch (_) {
    return '/';
  }
}

// No-throw terminal handler for the centralized request pipeline. If the
// response has not committed output yet, emit a generic error; otherwise output
// is already (partially) written or the response is unusable, so destroy the
// socket immediately instead of leaving it hung until the inactivity timeout
// (Finding 3, CWE-755/CWE-400).
function failRequest(res, statusCode) {
  try {
    if (!res.headersSent && !res.writableEnded && !res.destroyed && res.writable !== false) {
      sendError(res, statusCode);
      return;
    }
  } catch (_) {
    // fall through to a hard socket teardown
  }
  try {
    if (typeof res.destroy === 'function' && !res.destroyed) res.destroy();
    else if (res.socket && !res.socket.destroyed) res.socket.destroy();
  } catch (_) { /* no-throw */ }
}

// After the response has flushed, abort any request body that was never fully
// consumed, so a rejected body-bearing request cannot hold its socket open until
// the timeout. Paired with Connection: close on early error exits (Finding 4).
function drainAndClose(req, res) {
  const finish = () => {
    try {
      if (req && !req.complete && !req.destroyed) req.destroy();
    } catch (_) { /* no-throw */ }
  };
  if (res.writableEnded) finish();
  else {
    res.once('finish', finish);
    res.once('close', finish);
  }
}

// Emit a generic early-exit error while guaranteeing the connection is not left
// occupied by an unread request body: advertise Connection: close (plus any
// status-specific headers such as Allow) and abort the body once the error
// response flushes (Finding 4). Used for every early rejection.
function endWithError(req, res, statusCode, detail, extraHeaders) {
  try {
    if (!res.headersSent) {
      if (extraHeaders) {
        for (const key of Object.keys(extraHeaders)) res.setHeader(key, extraHeaders[key]);
      }
      res.setHeader('Connection', 'close');
    }
  } catch (_) { /* headers may already be locked */ }
  sendError(res, statusCode, detail);
  drainAndClose(req, res);
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
    // Body is unread at this point; close the connection and abort it after the
    // 415 flushes so an in-flight upload cannot hold the socket open (Finding 4).
    return endWithError(req, res, 415, 'Content-Type must be application/json');
  }
  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (err) {
    if (err.statusCode === 413) {
      // More body is still arriving; endWithError sends 413, advertises
      // Connection: close, then aborts the remaining upload after the flush.
      return endWithError(req, res, 413, 'Body exceeds maximum allowed size');
    }
    if (err.aborted) return; // client went away; nothing to send
    throw err;
  }
  let parsed;
  try {
    // The body has been fully consumed here, so a malformed-JSON 400 is safe to
    // send on a keep-alive connection (no unread bytes remain).
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch (_) {
    return sendError(res, 400, 'Malformed JSON body');
  }
  sendJson(res, 200, { received: parsed });
}

// --- Request dispatcher ---
async function dispatch(req, res) {
  // Every early rejection below routes through endWithError so that a request
  // carrying an (unread) body cannot leave the socket occupied until timeout,
  // and — during shutdown — the connection is correctly closed (Findings 4, 7).
  if (shuttingDown) {
    return endWithError(req, res, 503, 'Server is shutting down');
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    return endWithError(req, res, 405, `Method ${req.method} not allowed`, {
      Allow: Array.from(ALLOWED_METHODS).join(', '),
    });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return endWithError(req, res, 400, 'Invalid request URL');
  }
  const pathname = parsedUrl.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (pathname === '/health' || pathname === '/healthz' || pathname === '/readyz')) {
    return handleHealth(req, res);
  }
  if (req.method === 'POST' && pathname === '/echo') {
    return handleEcho(req, res);
  }
  return endWithError(req, res, 404, 'Resource not found');
}

// Lifecycle invariant (Finding 5): socket._activeRequests holds the number of
// in-flight requests on a (possibly pipelined/keep-alive) connection. It is
// incremented exactly once when a request begins and decremented exactly once
// when its response settles — either 'finish' (sent) or a premature 'close'
// (client went away). A socket is only safe to destroy during shutdown when this
// counter is zero, which prevents dropping an active pipelined request.
function requestHandler(req, res) {
  const socket = req.socket;
  if (socket) {
    socket._activeRequests = (typeof socket._activeRequests === 'number' ? socket._activeRequests : 0) + 1;
  }

  let settled = false;
  const settle = () => {
    if (settled) return; // exactly-once decrement
    settled = true;
    if (socket && typeof socket._activeRequests === 'number' && socket._activeRequests > 0) {
      socket._activeRequests -= 1;
    }
    // Once draining, close a socket as soon as its last in-flight request ends
    // so it is not reused (complements the Connection: close header, Finding 7).
    if (shuttingDown && socket && socket._activeRequests === 0 && !socket.destroyed) {
      socket.end();
    }
  };
  res.on('finish', settle);
  res.on('close', settle);

  // Log-safe: never emit the raw URL (query/userinfo may hold secrets) (Finding 6).
  req.on('error', (err) => log.warn('request stream error', { error: describeThrown(err).message }));
  res.on('error', (err) => log.warn('response stream error', { error: describeThrown(err).message }));
  req.on('aborted', () => log.warn('request aborted by client', { path: safePath(req) }));

  Promise.resolve()
    .then(() => dispatch(req, res))
    .catch((err) => {
      // Terminal, no-throw error handling: this catch must never itself throw or
      // reject (Finding 3), so both logging and finalization are guarded.
      try {
        log.error('unhandled request error', { error: describeThrown(err).message, path: safePath(req) });
        failRequest(res, 500);
      } catch (_) {
        try { if (res.socket && !res.socket.destroyed) res.socket.destroy(); } catch (_) { /* no-throw */ }
      }
    });
}

// --- Server + socket registry ---
const server = http.createServer(requestHandler);
server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = config.headersTimeoutMs;
server.keepAliveTimeout = config.keepAliveTimeoutMs;
server.timeout = config.requestTimeoutMs;
// Finding 8: bound the number of headers a single request may carry. Without an
// explicit limit this small API would accept thousands of headers (a cheap
// memory-amplification vector); 100 is ample for legitimate clients/proxies.
server.maxHeadersCount = 100;

const sockets = new Set();
server.on('connection', (socket) => {
  // Track in-flight requests per socket (see requestHandler lifecycle invariant).
  socket._activeRequests = 0;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

server.on('error', (err) => {
  const code = err && err.code;
  // Errors surfacing during an intentional shutdown are expected (e.g. sockets
  // torn down mid-flight); log and let the shutdown sequence own the exit code.
  if (shuttingDown) {
    log.warn('server error during shutdown', { error: describeThrown(err).message, code });
    return;
  }
  // Any other server/listen error means the service is NOT healthy. Emit a
  // sanitized diagnostic and terminate non-zero so a supervisor can react —
  // never leave the process running and falsely signaling success (exit 0).
  if (code === 'EADDRINUSE') {
    log.error('address in use, cannot bind', { host: config.host, port: config.port });
  } else if (code === 'EACCES') {
    log.error('permission denied binding port', { port: config.port });
  } else {
    log.error('fatal server error', { error: describeThrown(err).message, code });
  }
  process.exit(1);
});

// --- Graceful shutdown coordinator ---
let shuttingDown = false;
let forceTimer = null;
// Desired process exit code. It escalates MONOTONICALLY from 0 (clean signal) to
// 1 (a fatal event occurred), and can never de-escalate (Finding 10). Both the
// clean-close path and the forced-timeout path exit with this final value.
let desiredExitCode = 0;

function gracefulShutdown(signal, exitCode = 0) {
  // Monotonic escalation happens on EVERY call, even after draining has begun,
  // so a fatal error arriving during a signal-initiated drain still forces a
  // non-zero exit instead of being masked by the first (clean) exit code.
  if (exitCode > desiredExitCode) desiredExitCode = exitCode;

  if (shuttingDown) {
    // Drain already in progress; the escalated exit code above is recorded, and
    // the close/timer machinery is already set up (idempotent) — nothing else.
    log.warn('shutdown already in progress', { signal, desiredExitCode });
    return;
  }
  shuttingDown = true;
  log.info('shutdown initiated', { signal, exitCode: desiredExitCode });

  forceTimer = setTimeout(() => {
    log.error('grace period elapsed, forcing exit', { exitCode: desiredExitCode });
    for (const s of sockets) { try { s.destroy(); } catch (_) { /* no-throw */ } }
    process.exit(desiredExitCode);
  }, config.shutdownGraceMs);
  if (forceTimer.unref) forceTimer.unref();

  server.close((err) => {
    if (forceTimer) clearTimeout(forceTimer);
    if (err) {
      // A close error is itself a fatal event: escalate before exiting.
      log.error('error during server close', { error: describeThrown(err).message });
      if (desiredExitCode < 1) desiredExitCode = 1;
    } else {
      log.info('server closed cleanly');
    }
    process.exit(desiredExitCode);
  });

  // Finding 5: destroy ONLY sockets with no in-flight request. Sockets serving an
  // active (possibly pipelined) request are left alone; their settle() closes them
  // gracefully once the final response finishes, so no active request is dropped.
  let destroyed = 0;
  for (const socket of sockets) {
    if ((socket._activeRequests || 0) === 0) {
      try { socket.destroy(); destroyed += 1; } catch (_) { /* no-throw */ }
    }
  }
  // Finding 11: report a directly-computed count of sockets still serving active
  // requests rather than the stale registry size (entries are removed only later,
  // asynchronously, on each socket's 'close' event).
  let active = 0;
  for (const socket of sockets) {
    if ((socket._activeRequests || 0) > 0) active += 1;
  }
  log.info('idle sockets destroyed', { destroyed, active });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));

process.on('uncaughtException', (err) => {
  // Normalize safely: `err` may be any thrown value (e.g. `throw null`), not
  // necessarily an Error, so we must not dereference .message/.stack directly.
  const info = describeThrown(err);
  log.error('uncaughtException', { error: info.message, name: info.name, stack: info.stack });
  gracefulShutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  // Safe normalization instead of String(reason), which would invoke a
  // potentially hostile custom toString on the rejected value.
  const info = describeThrown(reason);
  log.error('unhandledRejection', { error: info.message, name: info.name });
  gracefulShutdown('unhandledRejection', 1);
});

// --- Bootstrap ---
server.listen(config.port, config.host, () => {
  // Report the RESOLVED address from server.address() rather than the requested
  // config values: when PORT=0 the kernel assigns an ephemeral port, so logging
  // config.port would misstate where the server is actually listening.
  const addr = server.address();
  const boundHost = (addr && typeof addr === 'object') ? addr.address : config.host;
  const boundPort = (addr && typeof addr === 'object') ? addr.port : config.port;
  log.info('server listening', {
    host: boundHost,
    port: boundPort,
    pid: process.pid,
    nodeVersion: process.version,
  });
});

module.exports = { server, config };
