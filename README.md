# Hardened HTTP Server

A production-grade, **dependency-free** Node.js HTTP server built entirely on Node.js built-in modules. It demonstrates comprehensive error handling, graceful shutdown, input validation, resource cleanup, and robust HTTP request processing.

## Overview

This server is a single self-contained entrypoint (`server.js`) that runs on any Node.js `>=18` runtime with **no `npm install`** and **no third-party packages**. All configuration is provided at runtime through environment variables with safe defaults.

## Prerequisites

- Node.js **>= 18** (tested on the current LTS line; e.g., v22.x).
- No dependencies to install — the server uses only Node.js built-in modules (`http`, `os`, `URL`, `process`).

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

## Endpoints

| Method | Path | Description | Success |
|---|---|---|---|
| `GET` / `HEAD` | `/health` (aliases `/healthz`, `/readyz`) | Liveness/readiness probe | `200` JSON `{status, uptimeSeconds, pid, host, timestamp}` |
| `POST` | `/echo` | Validates and echoes a JSON body | `200` JSON `{received: <parsed body>}` |

### Response Status Codes

| Code | When |
|---|---|
| `200` | Successful request |
| `400` | Invalid URL or malformed JSON body |
| `404` | Unknown route |
| `405` | HTTP method not allowed (only `GET`, `HEAD`, `POST` are accepted) |
| `413` | Request body exceeds `MAX_BODY_BYTES` |
| `415` | `Content-Type` is not `application/json` for `POST /echo` |
| `500` | Unexpected server error (no stack trace is leaked to the client) |
| `503` | Server is shutting down and not accepting new requests |

All error responses are generic JSON of the form `{ "error": "...", "status": <code> }` and never expose stack traces.

## Graceful Shutdown

On `SIGTERM` or `SIGINT` the server:

1. Flips into a draining state — new requests immediately receive `503`.
2. Stops accepting new connections and drains in-flight requests via `server.close()`.
3. Destroys idle keep-alive sockets from its socket registry so draining completes promptly.
4. Exits cleanly (code `0`) once draining finishes, or forces exit after `SHUTDOWN_GRACE_MS` if a connection refuses to close.

Process-level `uncaughtException` and `unhandledRejection` handlers log the error, trigger the same graceful shutdown, and exit with a **non-zero** code so an external supervisor (systemd, PM2, or a container orchestrator) can restart the process.

## Robustness Features

- **Error handling:** try/catch around handler logic, `req`/`res` `error`/`aborted` listeners, `server.on('error')` for `EADDRINUSE`/`EACCES`, and process-level `uncaughtException`/`unhandledRejection` guards.
- **Graceful shutdown:** connection draining, idle keep-alive socket teardown, and a bounded force-exit timer.
- **Input validation:** method allow-list (`405`), WHATWG `URL` parsing (`400`), `Content-Type` verification (`415`), body-size cap (`413`), and guarded `JSON.parse` (`400`).
- **Resource cleanup:** configured `requestTimeout`, `headersTimeout`, `keepAliveTimeout`, and socket timeouts; oversized/stalled bodies aborted; timers cleared on shutdown.
- **Robust request processing:** streamed body handling with early abort, consistent JSON responses, client-abort tolerance, and a health/readiness endpoint for orchestration probes.
