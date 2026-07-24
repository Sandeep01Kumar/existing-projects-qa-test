# Node.js + Express Tutorial Server

## Overview

A minimal Node.js server built on [Express](https://expressjs.com/) that exposes two
plain-text `GET` endpoints: one that returns `Hello world` and one that returns
`Good evening`. The entire application is a single, self-contained entrypoint:
`server.js`.

## Prerequisites

- **Node.js `>= 18`** (tested on Node **v22.23.1**).
- One dependency: **Express** (`^5.2.1`), installed via `npm install`.

## Installation

```bash
npm install
```

## Running the Server

```bash
npm start
# or:
node server.js
```

The server listens on `http://localhost:3000` by default. The port can be overridden
with the `PORT` environment variable (e.g. `PORT=4000 npm start`).

## Endpoints

| Method | Path | Response body |
|--------|------|---------------|
| GET | `/` | `Hello world` |
| GET | `/good-evening` | `Good evening` |

```bash
curl http://localhost:3000/              # -> Hello world
curl http://localhost:3000/good-evening  # -> Good evening
```
