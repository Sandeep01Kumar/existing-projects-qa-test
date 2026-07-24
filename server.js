// Minimal ExpressJS tutorial server.
// Exposes two plain-text GET endpoints ("Hello world" and "Good evening").
//
// Run it with:  npm start   (equivalently: node server.js)
// Then visit:   http://localhost:3000/            -> "Hello world"
//               http://localhost:3000/good-evening -> "Good evening"

// Load the Express framework (CommonJS require; no ESM import here).
const express = require('express');

// Create a single Express application instance.
const app = express();

// R2: root route returns the exact plain-text string "Hello world".
app.get('/', (req, res) => res.send('Hello world'));

// R3: second route returns the exact plain-text string "Good evening".
app.get('/good-evening', (req, res) => res.send('Good evening'));

// R4: bind to a configurable port (env override, default 3000) and start listening.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
