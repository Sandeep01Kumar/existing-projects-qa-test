// Minimal ExpressJS tutorial server.
// Exposes two plain-text GET endpoints ("Hello world" and "Good evening").
//
// Run it with:  npm start   (equivalently: node server.js)
// Then visit:   http://localhost:3000/            -> "Hello world"
//               http://localhost:3000/good-evening -> "Good evening"

const express = require('express');

const app = express();

// Match the two paths exactly: case-sensitive and no trailing-slash tolerance,
// so only the canonical URLs resolve (e.g. "/Good-Evening" and "/good-evening/" 404).
app.set('case sensitive routing', true);
app.set('strict routing', true);

app.get('/', (req, res) => res.send('Hello world'));
app.get('/good-evening', (req, res) => res.send('Good evening'));

// Bind to a configurable port (PORT env override, default 3000). In Express 5 the
// listen callback receives an error (e.g. EADDRINUSE) when the bind fails, so report
// it on stderr and exit non-zero instead of logging a misleading success message.
const PORT = process.env.PORT || 3000;
app.listen(PORT, (err) => {
  if (err) {
    console.error(`Failed to start server on port ${PORT}: ${err.code || err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Server listening on port ${PORT}`);
});
