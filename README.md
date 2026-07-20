# Hardened HTTP Server

A production-grade, **dependency-free** Node.js HTTP server built entirely on Node.js built-in modules. It demonstrates comprehensive error handling, graceful shutdown, input validation, resource cleanup, and robust HTTP request processing.

## Overview

This server is a single self-contained entrypoint (`server.js`) that runs on any Node.js `>=18` runtime with **no `npm install`** and **no third-party packages**. All configuration is provided at runtime through environment variables with safe defaults.

## Prerequisites

- Node.js **>= 18** (tested on Node **v22.23.1**).
- No dependencies to install — the server uses only the Node.js standard library: the `http` and `os` modules (loaded via `require`) plus the always-global `URL` and `process` APIs (no `require` needed).

## Running the Server

```bash
# Start the server (defaults to http://0.0.0.0:3000)
npm start
# or, equivalently:
node server.js

# Syntax-check without running:
npm run check
# or:
node --check server.js
```

Example with overrides:

```bash
PORT=8080 MAX_BODY_BYTES=524288 node server.js
```

## Configuration

All settings are environment variables with safe defaults:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_BODY_BYTES` | `1048576` | Maximum request body size in bytes (1 MB); larger bodies receive `413` |
| `REQUEST_TIMEOUT_MS` | `30000` | Maximum time for a full request (also socket inactivity timeout) |
| `HEADERS_TIMEOUT_MS` | `10000` | Maximum time to receive request headers |
| `KEEPALIVE_TIMEOUT_MS` | `5000` | Keep-alive timeout for idle connections |
| `SHUTDOWN_GRACE_MS` | `10000` | Grace period before a forced exit during shutdown |
| `MAX_JSON_DEPTH` | `200` | Maximum accepted JSON nesting depth for a `POST /echo` body; deeper payloads receive `400` (range-checked at startup, ceiling `1000`) |

> Header and request timeouts are **actively enforced**: the server derives a bounded incomplete-request check interval from the smallest configured timeout, so a slow or byte-trickling client is disconnected shortly after its deadline rather than lingering. A timeout enforced at the protocol layer is surfaced as `408`. Configured timeout and body-size values are also range-checked at startup (e.g. body size is capped at 100 MiB and timers at 1 hour); an out-of-range value makes the server log a configuration error and refuse to start.

## Endpoints

| Method | Path | Description | Success |
|---|---|---|---|
| `GET` / `HEAD` | `/health` (aliases `/healthz`, `/readyz`) | Liveness/readiness probe | `200` JSON `{status, uptimeSeconds, pid, host, timestamp}` |
| `POST` | `/echo` | Validates and echoes a JSON body | `200` JSON `{received: <parsed body>}` |

> **`HEAD` requests** return the same status line and headers as the equivalent `GET` — including a `Content-Length` computed from the JSON body — but **no response body** (0 bytes), per the HTTP specification.

### Response Status Codes

| Code | When |
|---|---|
| `200` | Successful request |
| `400` | Invalid URL, malformed JSON body, or a JSON body nested deeper than `MAX_JSON_DEPTH` |
| `404` | Unknown route |
| `405` | HTTP method not allowed (only `GET`, `HEAD`, `POST` are accepted); also returned for `CONNECT` |
| `408` | Request/headers timeout enforced at the protocol layer (slow or incomplete request) |
| `413` | Request body exceeds `MAX_BODY_BYTES` |
| `415` | `Content-Type` is not `application/json` for `POST /echo` |
| `417` | Unsupported `Expect` request-header value |
| `500` | Unexpected server error (no stack trace is leaked to the client) |
| `503` | Server is shutting down; a request that reaches the dispatcher during draining is refused with this status (see [Graceful Shutdown](#graceful-shutdown)) |

All error responses are generic JSON of the form `{ "error": "<status message>", "status": <code>, "detail"?: "<short reason>" }`. The optional `detail` field carries a brief, non-sensitive reason (for example, `"Content-Type must be application/json"`) and is omitted when there is none. Stack traces are never exposed to clients.

### Protocol-Level Handling

Traffic that never reaches normal routing is still answered defensively with the same generic JSON shape for every case the application can intercept:

- **Malformed request line/headers** (`clientError`) → `400`; a request/headers timeout detected at this layer → `408`.
- **`CONNECT`** (tunneling is not supported) → `405` with an `Allow` header.
- **Unsupported `Expect` request header** → `417`.

> **Platform exception.** A few protocol violations are rejected by the Node.js HTTP parser *before* any JavaScript handler can run — most notably an `HTTP/1.1` request that omits the mandatory `Host` header, which Node answers with its own **bare `400`** (not the JSON envelope) and closes the connection. This built-in protection cannot be intercepted without disabling it, so those rare, non-conformant requests receive Node's default `400` rather than the application's JSON body. The outcome is still a safe `400` with the connection closed.

## Graceful Shutdown

On `SIGTERM` or `SIGINT` the server drains in-flight work and then exits:

1. It enters a **draining** state and stops accepting new connections via `server.close()`. From this point:
   - **New TCP connections are refused** — the listening socket is closed, so a client opening a fresh connection sees a connection error (e.g. `ECONNREFUSED`), not an HTTP response.
   - **Requests that still reach the dispatcher** on an already-established connection are refused with `503` and `Connection: close`.
   - **Idle keep-alive sockets** are destroyed immediately from the socket registry so draining completes promptly; a socket serving an active request is left alone until its response finishes.
2. In-flight requests are allowed to complete; each response is sent with `Connection: close`.
3. Once all in-flight work has drained, the process **exits `0`** (clean shutdown).
4. If draining does not complete within `SHUTDOWN_GRACE_MS`, the remaining sockets are force-destroyed and the process **exits with a non-zero code** — a forced termination is never reported as success.

Process-level `uncaughtException` and `unhandledRejection` handlers log a **sanitized** error, trigger the same graceful shutdown, and exit **non-zero** so an external supervisor (systemd, PM2, or a container orchestrator) can restart the process. A server-level error that occurs *during* shutdown is likewise treated as fatal and escalates the exit code to non-zero.

> **⚠️ Signal delivery and `npm start` (especially on Windows).** Graceful shutdown depends on the Node.js process receiving `SIGTERM`/`SIGINT` **directly**. When the server is started through the `npm start` wrapper, a signal sent to the wrapper is not reliably forwarded to the underlying Node.js process on Windows, so the server can keep running after the wrapper is killed — bypassing the shutdown sequence. For supervised or production deployments, launch the server **directly** with `node server.js` (or configure your process manager to signal the Node.js PID) so the graceful-shutdown sequence actually runs.

## Robustness Features

- **Error handling:** try/catch around handler logic, `req`/`res` `error`/`aborted` listeners, protocol-level `clientError`/`CONNECT`/`Expect` handling, `server.on('error')` for `EADDRINUSE`/`EACCES`, and process-level `uncaughtException`/`unhandledRejection` guards.
- **Graceful shutdown:** connection draining, idle keep-alive socket teardown, a bounded force-exit timer, and a monotonic **non-zero** exit code on forced or fatal termination.
- **Input validation:** method allow-list (`405`), WHATWG `URL` parsing (`400`), `Content-Type` verification (`415`), body-size cap (`413`), a JSON nesting-depth cap (`400`, bounded *before* `JSON.parse` so a pathologically deep payload cannot exhaust the call stack), and guarded `JSON.parse` (`400`).
- **Resource cleanup:** configured `requestTimeout`, `headersTimeout`, `keepAliveTimeout`, and socket timeouts; oversized/stalled bodies aborted; timers cleared on shutdown.
- **Robust request processing:** streamed body handling with early abort, consistent JSON responses, client-abort tolerance, and a health/readiness endpoint for orchestration probes.
- **Structured, resilient logging:** newline-delimited JSON to stdout/stderr, with secrets (credentials, bearer tokens) redacted, control characters stripped, and messages length-bounded; stack traces and runtime build details are never logged. A broken or blocked log sink (for example, a closed pipe) is isolated and never crashes the server.
