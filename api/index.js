/* =============================================================================
 * api/index.js — Vercel serverless entrypoint (catch-all)
 * =============================================================================
 * Every request is rewritten here by vercel.json. We simply delegate to the
 * SAME request handler the local server uses (`requestListener` exported from
 * server.js), so the app behaves identically whether it runs as `node server.js`
 * locally or as a Vercel function in the cloud.
 *
 * On Vercel the filesystem is ephemeral, so data MUST come from Firestore:
 * set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (and
 * optionally ADMIN_PASS) in the Vercel project env. Without those, store.js
 * falls back to the read-only bundled data/db.json (writes won't persist).
 * ========================================================================== */

'use strict';

const { requestListener } = require('../server');

module.exports = (req, res) => requestListener(req, res);
