/* =============================================================================
 * store.js — THE ONLY DATA-ACCESS MODULE (the thin, swappable data layer)
 * =============================================================================
 *
 * Tango Buddy POC — env-gated TRIPLE BACKEND (chosen once, at runtime).
 * Precedence: D1 -> Firestore -> local JSON.
 *
 *   1) CLOUDFLARE D1 — used when CF_ACCOUNT_ID + CF_D1_DATABASE_ID +
 *      CF_D1_API_TOKEN are present. THE PRODUCTION STORE. Reached over the
 *      Cloudflare REST API (not a native binding) because the app is hosted on
 *      Vercel; a later move to CF Pages turns the same DB into a binding with
 *      no migration. Stored as one generic docs(collection,id,json) table plus
 *      a SQL view per collection — see d1/schema.sql.
 *
 *   2) FIRESTORE  — used when the Firebase service-account envs are present
 *      (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).
 *      `firebase-admin` is required LAZILY, only on that path, so local dev
 *      never needs it installed. RETAINED BUT UNUSED — superseded by D1
 *      (Toby, 2026-07-20); kept in place rather than deleted.
 *      Collections:
 *        newbies, volunteers, organizers, studios, events, checkins, threads, messages, meta
 *
 *   3) LOCAL JSON — the default (no cloud envs): reads/writes poc/data/db.json
 *      with Node's built-in `fs`. Zero dependencies, unchanged local behavior.
 *      NOTE: on Vercel with no cloud envs this writes to /tmp and is LOST on
 *      cold start. That is the failure mode D1 exists to end — it is why the
 *      D1 backend fails LOUD instead of falling back to here.
 *
 * >>> THIS FILE IS THE ONLY THING THAT KNOWS WHICH BACKEND IS IN USE. <<<
 * Everything above store.js (app.js, the pages, the token/tb_token flow) is
 * backend-agnostic — it only ever awaits these functions.
 *
 * All public functions are ASYNC (they return Promises) so the same surface
 * works for both the synchronous file backend and the async Firestore backend.
 *
 * Public surface (stable across any swap — all async):
 *   addNewbie(data) · listNewbies() · findNewbieByToken(token)
 *   addVolunteer(data) · listVolunteers() · setMatch(newbieId, volId)
 *   listTeachers()                       (organizers inventory, used by EVENTS)
 *   listStudios() · addStudio(data) · updateStudio(studioId, data)  (LESSONS tab)
 *   getOrCreateBuddyThread(newbieId) · getRollingNewbiesThread()
 *   listMessages(threadId) · postMessage(threadId, fromName, body)
 *   listEvents() · addEvent(data) · updateEvent(eventId, data)
 *   addOrganizer(data) · updateOrganizer(orgId, data)
 *   checkIn(newbieId, eventId, status, eventSnapshot?) · listCheckinsForNewbie(newbieId)
 *   setReady(newbieId, ready) · setHandover(newbieId, organizerId)
 *   listUpdates() · listIdeas() · listTodos()
 *
 * Data shapes:
 *   newbie    { id, token, name, contact, platform, note, consent, status, buddyId,
 *               origination, readyForLessons, handedToOrganizerId, createdAt }
 *   volunteer { id, name, contact, area, availability, note, createdAt }
 *   organizer { id, name, studio, code, blurb, email, phone, whatsapp, web, demo }  (a.k.a teacher — used by EVENTS)
 *   studio    { id, name, phone, web, createdAt }                    (Studios/Teachers — the LESSONS tab)
 *   thread    { id, kind, newbieId, createdAt }   kind: 'buddy' | 'social'
 *   message   { id, threadId, fromName, body, createdAt }
 *   event     { id, ttId, url, shortName, orgName, startDate, venueName, category, image,
 *               beginnerFriendly, title, type, date, time, location, organizerId, link, source, demo, createdAt }
 *               (ttId/url/shortName/orgName/startDate/venueName/category/image are the
 *                TangoTiempo-pulled fields; title/type/date/time/location remain for
 *                legacy/manual events + the token-home landing.)
 *   checkin   { id, newbieId, eventId, status, when, updatedAt,
 *               eventTitle, eventDate, eventOrg, eventUrl }
 *               status: 'going' | 'went'
 *               id is DERIVED as c_<newbieId>_<eventId> -> one row per pair (upsert).
 *               when = first check-in (stable); updatedAt = last change.
 *               event* = snapshot of the event AT CHECK-IN TIME. Events are live
 *               from a rolling 2-week feed, so history must render from these
 *               fields, never from a live event lookup. May be absent on legacy rows.
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
// Vercel-safe write target. On Vercel the project filesystem (where the bundled
// seed DB_PATH lives) is READ-ONLY, but /tmp is writable within a warm instance.
const TMP_PATH = '/tmp/db.json';
const ON_VERCEL = !!process.env.VERCEL;

// Backend selection: Firestore ONLY when the full credential set is present.
const USE_FIRESTORE = !!(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
);

// D1 ONLY when the full credential set is present. Takes precedence over both
// of the above (see `backend` selection below).
const USE_D1 = !!(
  process.env.CF_ACCOUNT_ID &&
  process.env.CF_D1_DATABASE_ID &&
  process.env.CF_D1_API_TOKEN
);

function id(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- backend abstraction --------------------------------------------
 * Both backends expose the SAME tiny surface. The public API below is written
 * once, on top of it (read-modify-write for updates), so nothing about the
 * chosen backend leaks upward.
 *
 *   all(coll)            -> [doc]
 *   get(coll, docId)     -> doc | null
 *   set(coll, docId, doc)-> doc          (create OR replace)
 *   meta()               -> { updates, ideas, todos }
 * ------------------------------------------------------------------------- */

// ---- LOCAL JSON backend (default; zero-dependency) -------------------------
// The organizers inventory is stored under the legacy `teachers` key in the
// JSON file (preserves the existing db.json structure). Firestore uses the
// `organizers` collection name.
const JSON_KEYS = { organizers: 'teachers' };
function jkey(coll) { return JSON_KEYS[coll] || coll; }

// Decide (once, cached) where writes go. The /tmp redirect is a VERCEL-ONLY
// concern: on Vercel the project filesystem is read-only, so we write to /tmp.
// In local dev (no VERCEL env) we ALWAYS write to data/db.json — never /tmp —
// so local testing is safe and deterministic and can't be shadowed by a stale
// /tmp/db.json.
let _writePath = null;
function writePath() {
  if (_writePath) return _writePath;
  _writePath = ON_VERCEL ? TMP_PATH : DB_PATH;
  return _writePath;
}

function readFile() {
  let raw = null;
  // /tmp is a VERCEL-ONLY read preference: on a warm Vercel instance a prior write
  // lands in /tmp, so prefer it there. In local dev (no VERCEL) we NEVER touch
  // /tmp — reads come straight from data/db.json (the real seed), so a stale
  // /tmp/db.json can never shadow it.
  if (ON_VERCEL) {
    try { raw = fs.readFileSync(TMP_PATH, 'utf8'); } catch (e) { raw = null; }
  }
  if (raw == null) {
    try { raw = fs.readFileSync(DB_PATH, 'utf8'); } catch (e) { raw = null; }
  }
  let db;
  try { db = JSON.parse(raw); }
  catch (e) { db = {}; }
  db.newbies = db.newbies || [];
  db.volunteers = db.volunteers || [];
  db.teachers = db.teachers || [];
  db.studios = db.studios || [];
  db.threads = db.threads || [];
  db.messages = db.messages || [];
  db.events = db.events || [];
  db.checkins = db.checkins || [];
  db.meta = db.meta || {};
  db.meta.updates = db.meta.updates || [];
  db.meta.ideas = db.meta.ideas || [];
  db.meta.todos = db.meta.todos || [];
  return db;
}

function writeFile(db) {
  // Copy-on-first-write: readFile() has already merged the bundled seed into `db`,
  // so writing the whole object to /tmp is itself the seed copy on a cold instance.
  fs.writeFileSync(writePath(), JSON.stringify(db, null, 2));
}

const jsonBackend = {
  async all(coll) { return readFile()[jkey(coll)] || []; },
  async get(coll, docId) {
    return (readFile()[jkey(coll)] || []).find((r) => r.id === docId) || null;
  },
  async set(coll, docId, doc) {
    const db = readFile();
    const k = jkey(coll);
    db[k] = db[k] || [];
    const i = db[k].findIndex((r) => r.id === docId);
    if (i >= 0) db[k][i] = doc; else db[k].push(doc);
    writeFile(db);
    return doc;
  },
  async meta() {
    const m = readFile().meta;
    return { updates: m.updates || [], ideas: m.ideas || [], todos: m.todos || [] };
  },
};

// ---- FIRESTORE backend (lazy; only when envs present) ----------------------
let _fs = null;
function firestore() {
  if (_fs) return _fs;
  // Lazy require: this line only ever runs when the Firebase envs are set, so a
  // local dev checkout without `firebase-admin` installed never hits it.
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Env vars store the PEM with literal "\n"; restore real newlines.
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  _fs = admin.firestore();
  return _fs;
}

const firestoreBackend = {
  async all(coll) {
    const snap = await firestore().collection(coll).get();
    return snap.docs.map((d) => d.data());
  },
  async get(coll, docId) {
    const d = await firestore().collection(coll).doc(docId).get();
    return d.exists ? d.data() : null;
  },
  async set(coll, docId, doc) {
    await firestore().collection(coll).doc(docId).set(doc);
    return doc;
  },
  async meta() {
    const d = await firestore().collection('meta').doc('content').get();
    const m = d.exists ? d.data() : {};
    return { updates: m.updates || [], ideas: m.ideas || [], todos: m.todos || [] };
  },
};

// ---- CLOUDFLARE D1 backend (REST; only when envs present) ------------------
// Reached over the Cloudflare REST API rather than a native binding, because the
// app is hosted on Vercel. If BTB later moves to CF Pages, the SAME database
// becomes a native binding — no data migration, no schema rework.
//
// Storage shape: one generic `docs(collection, id, json, updatedAt)` table, with
// a SQL view per collection (see d1/schema.sql) so the data stays readable by
// hand. The generic shape is what lets all ~25 public functions below work
// against D1 without a single change.
//
// Uses built-in fetch (Node 18+ on Vercel) — no new npm dependency.

const D1_ENDPOINT = () =>
  `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}` +
  `/d1/database/${process.env.CF_D1_DATABASE_ID}/query`;

// Every statement goes through here. ALWAYS parameterised (`?`) — user input is
// never concatenated into SQL.
//
// FAIL LOUD: if the D1 envs are set but a call fails, we log and throw. We do
// NOT fall back to the JSON/tmp backend. Silent fallback to an ephemeral /tmp
// file is precisely the bug this phase exists to fix — a signup that "succeeds"
// into a disappearing file is worse than a signup that visibly errors.
async function d1Query(sql, params) {
  let res;
  try {
    res = await fetch(D1_ENDPOINT(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CF_D1_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params: params || [] }),
    });
  } catch (e) {
    console.error('[store/D1] network failure:', e && e.message, '| sql:', sql);
    throw new Error(`D1 request failed: ${e && e.message}`);
  }

  const bodyText = await res.text();
  let body;
  try { body = JSON.parse(bodyText); }
  catch (e) {
    console.error('[store/D1] non-JSON response', res.status, bodyText.slice(0, 400));
    throw new Error(`D1 returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok || body.success === false) {
    // CF returns a structured errors[] — surface it verbatim, it is the only
    // way to tell "bad token" from "no such table" from "SQL syntax".
    const errs = (body.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ')
      || `HTTP ${res.status}`;
    console.error('[store/D1] query failed:', errs, '| sql:', sql);
    throw new Error(`D1 query failed: ${errs}`);
  }

  // Shape: { result: [ { results: [...], success, meta } ], success: true }
  const first = Array.isArray(body.result) ? body.result[0] : null;
  return (first && first.results) || [];
}

// Rows come back as { json: '<serialized doc>' }. One place to parse them, so a
// corrupt row is reported with its collection rather than blowing up opaquely.
function d1Parse(rows, coll) {
  const out = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.json)); }
    catch (e) {
      console.error(`[store/D1] unparseable json in ${coll}, skipping row:`, r.id);
    }
  }
  return out;
}

const d1Backend = {
  async all(coll) {
    return d1Parse(
      await d1Query('SELECT id, json FROM docs WHERE collection = ?', [coll]),
      coll,
    );
  },
  async get(coll, docId) {
    const rows = await d1Query(
      'SELECT id, json FROM docs WHERE collection = ? AND id = ?', [coll, docId],
    );
    return d1Parse(rows, coll)[0] || null;
  },
  async set(coll, docId, doc) {
    await d1Query(
      'INSERT INTO docs (collection, id, json, updatedAt) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(collection, id) DO UPDATE SET json = excluded.json, ' +
      'updatedAt = excluded.updatedAt',
      [coll, docId, JSON.stringify(doc), new Date().toISOString()],
    );
    return doc;
  },
  async meta() {
    // Mirrors the Firestore backend: a single `content` doc in `meta`.
    const m = (await d1Backend.get('meta', 'content')) || {};
    return { updates: m.updates || [], ideas: m.ideas || [], todos: m.todos || [] };
  },
};

// Precedence: D1 -> Firestore -> local JSON. Local dev with no envs set is
// unchanged (jsonBackend against data/db.json).
const backend = USE_D1 ? d1Backend : (USE_FIRESTORE ? firestoreBackend : jsonBackend);

/* ---------- public API (all async) ----------------------------------------- */

/* --- field helpers for the extended signup ---------------------------------
 * These exist to protect ONE distinction: "absent" and "no" are different facts.
 *
 * The 7 backfilled historical newcomers were never asked whether they want a
 * buddy, or whether they have danced before. Writing `false` onto those records
 * would state, as fact, that they answered "no" — and Toby might act on that
 * (e.g. never offering a buddy to someone who was simply never asked). So a
 * field that was not supplied is OMITTED, never defaulted.
 * ------------------------------------------------------------------------- */

// Tri-state: true | false | undefined. Returns undefined when the caller did
// not supply the field at all, so the key can be left off the record entirely.
function tri(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toLowerCase();
  if (s === '') return undefined;
  if (['true', 'yes', 'on', '1', 'y'].includes(s)) return true;
  if (['false', 'no', 'off', '0', 'n'].includes(s)) return false;
  return undefined; // unrecognised -> treat as not answered rather than as "no"
}

// Assign only when there is something to assign, so absent stays absent.
function put(obj, key, value) {
  if (value !== undefined) obj[key] = value;
}
function putStr(obj, key, value) {
  const s = (value === undefined || value === null) ? '' : String(value).trim();
  if (s !== '') obj[key] = s;
}

async function addNewbie(data) {
  // The combined `name` stays authoritative and is ALWAYS written: admin, the
  // "Hello, {name}" banner and the D1 newbies view all read it, and the 7
  // backfilled historical rows have only a single combined name. When the form
  // supplies first/last we compose it; otherwise we keep whatever `name` came in.
  const first = (data.firstName || '').trim();
  const last = (data.lastName || '').trim();
  const combined = [first, last].filter(Boolean).join(' ');

  const newbie = {
    id: id('n'),
    // A random device token = the newbie's light identity (no login). The client
    // stores it in localStorage (tb_token) for the with-token home on return.
    token: id('tok'),
    name: combined || (data.name || '').trim(),
    contact: (data.contact || '').trim(),
    platform: (data.platform || '').trim(),
    note: (data.note || '').trim(),
    consent: data.consent === true || data.consent === 'true' || data.consent === 'on',
    status: 'new',
    buddyId: null,
    origination: (data.origination || '').trim(),
    readyForLessons: false,
    handedToOrganizerId: null,
    createdAt: new Date().toISOString(),
  };

  // --- V1.1.0 signup fields. All optional; omitted when not supplied. ---
  putStr(newbie, 'firstName', first);
  putStr(newbie, 'lastName', last);
  putStr(newbie, 'contact2', data.contact2);      // optional 2nd contact method
  putStr(newbie, 'platform2', data.platform2);
  putStr(newbie, 'dancedWhat', data.dancedWhat);  // e.g. "salsa, swing"
  put(newbie, 'wantsBuddy', tri(data.wantsBuddy));            // explicit opt-in
  put(newbie, 'dancedBefore', tri(data.dancedBefore));
  put(newbie, 'dancedTangoBefore', tri(data.dancedTangoBefore));

  await backend.set('newbies', newbie.id, newbie);
  return newbie;
}

async function listNewbies() {
  return backend.all('newbies');
}

// Resolve a device token back to its newbie (the light, no-login identity).
async function findNewbieByToken(token) {
  if (!token) return null;
  const all = await backend.all('newbies');
  return all.find((n) => n.token === token) || null;
}

// NOTE: this whitelists too, and had the same silent-drop trap as addNewbie —
// a field the form collects but this function does not name is discarded while
// the volunteer still sees the thank-you screen. No volunteer-specific new
// fields have been specced yet, so this mirrors the newbie shape (first/last +
// optional second contact) to keep the two forms symmetrical and to stop the
// trap re-appearing the moment the buddy form grows.
async function addVolunteer(data) {
  const first = (data.firstName || '').trim();
  const last = (data.lastName || '').trim();
  const combined = [first, last].filter(Boolean).join(' ');

  const volunteer = {
    id: id('v'),
    name: combined || (data.name || '').trim(),
    contact: (data.contact || '').trim(),
    area: (data.area || '').trim(),
    availability: (data.availability || '').trim(),
    note: (data.note || '').trim(),
    createdAt: new Date().toISOString(),
  };
  putStr(volunteer, 'firstName', first);
  putStr(volunteer, 'lastName', last);
  putStr(volunteer, 'contact2', data.contact2);
  putStr(volunteer, 'platform2', data.platform2);

  await backend.set('volunteers', volunteer.id, volunteer);
  return volunteer;
}

async function listVolunteers() {
  return backend.all('volunteers');
}

// Assign (or clear, if volId is falsy) a buddy for a newbie.
async function setMatch(newbieId, volId) {
  const newbie = await backend.get('newbies', newbieId);
  if (!newbie) return null;
  newbie.buddyId = volId || null;
  newbie.status = volId ? 'matched' : 'new';
  await backend.set('newbies', newbie.id, newbie);
  return newbie;
}

// Organizers = the collection attached to EVENTS (they run milongas/practicas).
// Stored under the legacy `teachers` key in the JSON file; NOT the Lessons list.
async function listTeachers() {
  return backend.all('organizers');
}

/* --- studios / teachers (the LESSONS tab) ----------------------------------
 * A SEPARATE collection from organizers: real Boston studios that teach
 * beginner lessons. Names may overlap with organizers, but this is its own
 * list (the /lessons tab). Only name / phone / web — call + website CTAs. */

async function listStudios() {
  return backend.all('studios');
}

async function addStudio(data) {
  const studio = {
    id: id('s'),
    name: (data.name || '').trim(),
    phone: (data.phone || '').trim(),
    web: (data.web || '').trim(),
    createdAt: new Date().toISOString(),
  };
  await backend.set('studios', studio.id, studio);
  return studio;
}

async function updateStudio(studioId, data) {
  const studio = await backend.get('studios', studioId);
  if (!studio) return null;
  ['name', 'phone', 'web'].forEach((k) => {
    if (data[k] !== undefined) studio[k] = String(data[k]).trim();
  });
  await backend.set('studios', studio.id, studio);
  return studio;
}

/* --- chat / social layer --------------------------------------------------- */

const SOCIAL_ID = 'thread_social';

async function getOrCreateBuddyThread(newbieId) {
  const all = await backend.all('threads');
  let thread = all.find((t) => t.kind === 'buddy' && t.newbieId === newbieId);
  if (!thread) {
    thread = { id: id('thread'), kind: 'buddy', newbieId, createdAt: new Date().toISOString() };
    await backend.set('threads', thread.id, thread);
  }
  return thread;
}

async function getRollingNewbiesThread() {
  let thread = await backend.get('threads', SOCIAL_ID);
  if (!thread) {
    thread = { id: SOCIAL_ID, kind: 'social', newbieId: null, createdAt: new Date().toISOString() };
    await backend.set('threads', SOCIAL_ID, thread);
  }
  return thread;
}

async function listMessages(threadId) {
  const all = await backend.all('messages');
  return all.filter((m) => m.threadId === threadId);
}

async function postMessage(threadId, fromName, body) {
  const message = {
    id: id('msg'),
    threadId,
    fromName: (fromName || 'Someone').trim() || 'Someone',
    body: (body || '').trim(),
    createdAt: new Date().toISOString(),
  };
  await backend.set('messages', message.id, message);
  return message;
}

/* --- events / check-in / handover ------------------------------------------ */

async function listEvents() {
  const all = await backend.all('events');
  // Sort by whenever the event happens: TangoTiempo events carry an ISO
  // `startDate`; legacy/manual events carry `date` (+ `time`).
  return all.slice().sort((a, b) =>
    ((a.startDate || a.date || '') + (a.time || ''))
      .localeCompare((b.startDate || b.date || '') + (b.time || '')));
}

async function addEvent(data) {
  const event = {
    id: id('e'),
    // --- TangoTiempo-pulled fields ---
    ttId: (data.ttId || '').trim() || null,
    url: (data.url || '').trim(),
    shortName: (data.shortName || '').trim(),
    orgName: (data.orgName || '').trim(),
    startDate: (data.startDate || '').trim(),
    venueName: (data.venueName || '').trim(),
    category: (data.category || '').trim(),
    image: data.image ? String(data.image).trim() : null,
    // --- legacy / manual fields (also used by the token-home landing) ---
    title: (data.title || '').trim(),
    type: (data.type || data.category || '').trim(),
    date: (data.date || '').trim(),
    time: (data.time || '').trim(),
    location: (data.location || '').trim(),
    organizerId: (data.organizerId || '').trim() || null,
    // link deep-links to TangoTiempo; default to the pulled url when present.
    link: (data.link || data.url || '').trim(),
    source: (data.source || '').trim(),
    // Normalized beginner-friendly flag (computed in tangotiempo.js from the API's
    // for/friendly flags + overrides). Drives the /events beginner-only filter.
    beginnerFriendly: data.beginnerFriendly === true || data.beginnerFriendly === 'true',
    demo: data.demo === true || data.demo === 'true',
    createdAt: new Date().toISOString(),
  };
  await backend.set('events', event.id, event);
  return event;
}

async function updateEvent(eventId, data) {
  const event = await backend.get('events', eventId);
  if (!event) return null;
  ['title', 'type', 'date', 'time', 'location', 'link',
    'url', 'shortName', 'orgName', 'startDate', 'venueName', 'category'].forEach((k) => {
    if (data[k] !== undefined) event[k] = String(data[k]).trim();
  });
  if (data.organizerId !== undefined) event.organizerId = String(data.organizerId).trim() || null;
  if (data.ttId !== undefined) event.ttId = String(data.ttId).trim() || null;
  if (data.image !== undefined) event.image = data.image ? String(data.image).trim() : null;
  if (data.beginnerFriendly !== undefined) {
    event.beginnerFriendly = data.beginnerFriendly === true || data.beginnerFriendly === 'true';
  }
  await backend.set('events', event.id, event);
  return event;
}

async function addOrganizer(data) {
  const organizer = {
    id: id('t'),
    name: (data.name || '').trim(),
    studio: (data.studio || '').trim(),
    code: (data.code || '').trim(),
    blurb: (data.blurb || '').trim(),
    email: (data.email || '').trim(),
    phone: (data.phone || '').trim(),
    whatsapp: (data.whatsapp || '').trim(),
    web: (data.web || '').trim(),
    demo: data.demo === true || data.demo === 'true',
  };
  await backend.set('organizers', organizer.id, organizer);
  return organizer;
}

async function updateOrganizer(orgId, data) {
  const organizer = await backend.get('organizers', orgId);
  if (!organizer) return null;
  ['name', 'studio', 'code', 'blurb', 'email', 'phone', 'whatsapp', 'web'].forEach((k) => {
    if (data[k] !== undefined) organizer[k] = String(data[k]).trim();
  });
  await backend.set('organizers', organizer.id, organizer);
  return organizer;
}

// One check-in per (newbieId, eventId). The id is DERIVED from the pair rather
// than random, so backend.set() upserts naturally: a second tap on the same
// event updates the existing row instead of inserting a duplicate. Without this
// a nervous double-tap inflates the retention numbers (it already happened —
// two identical 'went' rows landed 0.5s apart during testing).
function checkinId(newbieId, eventId) {
  const safe = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  return `c_${safe(newbieId)}_${safe(eventId)}`;
}

/**
 * Record (or update) a newbie's check-in against an event.
 *
 * @param {string} newbieId
 * @param {string} eventId
 * @param {string} status          'going' | 'went'  (anything else -> 'going')
 * @param {object} [eventSnapshot] { eventTitle, eventDate, eventOrg, eventUrl }
 *
 * WHY THE SNAPSHOT: events come live from the appId=1 feed on a rolling TWO-WEEK
 * window, so an event referenced only by `eventId` becomes unresolvable a
 * fortnight later and the history renders as "(event removed)". Copying the
 * display fields onto the check-in row at the moment it happens is what keeps
 * the retention signal readable forever. RENDER HISTORY FROM THESE FIELDS,
 * never from a live event lookup.
 */
async function checkIn(newbieId, eventId, status, eventSnapshot) {
  const rowId = checkinId(newbieId, eventId);
  const existing = await backend.get('checkins', rowId);
  const snap = eventSnapshot || {};
  const str = (v) => (v == null ? '' : String(v).trim());

  const checkin = {
    id: rowId,
    newbieId,
    eventId,
    status: status === 'went' ? 'went' : 'going',
    // `when` = when they FIRST checked in; preserved across re-taps so the
    // history keeps a stable order and re-tapping an old event does not yank it
    // to the top of the list.
    when: (existing && existing.when) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Event snapshot. On a re-tap, only overwrite a field when the caller
    // actually supplied it — a later status-only call must not blank out a
    // snapshot captured earlier.
    eventTitle: str(snap.eventTitle) || (existing && existing.eventTitle) || '',
    eventDate: str(snap.eventDate) || (existing && existing.eventDate) || '',
    eventOrg: str(snap.eventOrg) || (existing && existing.eventOrg) || '',
    eventUrl: str(snap.eventUrl) || (existing && existing.eventUrl) || '',
  };
  await backend.set('checkins', rowId, checkin);
  return checkin;
}

async function listCheckinsForNewbie(newbieId) {
  const all = await backend.all('checkins');
  return all
    .filter((c) => c.newbieId === newbieId)
    // Newest first. Tolerant of rows written before `when` was guaranteed and of
    // legacy rows with no snapshot fields — every read must tolerate absence.
    .sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
}

async function setReady(newbieId, ready) {
  const newbie = await backend.get('newbies', newbieId);
  if (!newbie) return null;
  newbie.readyForLessons = ready === true || ready === 'true' || ready === 'on' || ready === '1';
  await backend.set('newbies', newbie.id, newbie);
  return newbie;
}

async function setHandover(newbieId, organizerId) {
  const newbie = await backend.get('newbies', newbieId);
  if (!newbie) return null;
  newbie.handedToOrganizerId = organizerId || null;
  if (organizerId) newbie.readyForLessons = true;
  await backend.set('newbies', newbie.id, newbie);
  return newbie;
}

/* --- meta content (footer-only pages: updates / ideas / todos) -------------- */

async function listUpdates() { return (await backend.meta()).updates; }
async function listIdeas() { return (await backend.meta()).ideas; }
async function listTodos() { return (await backend.meta()).todos; }

module.exports = {
  addNewbie,
  listNewbies,
  findNewbieByToken,
  addVolunteer,
  listVolunteers,
  setMatch,
  listTeachers,
  listStudios,
  addStudio,
  updateStudio,
  getOrCreateBuddyThread,
  getRollingNewbiesThread,
  listMessages,
  postMessage,
  listEvents,
  addEvent,
  updateEvent,
  addOrganizer,
  updateOrganizer,
  checkIn,
  listCheckinsForNewbie,
  setReady,
  setHandover,
  listUpdates,
  listIdeas,
  listTodos,
  // exposed for diagnostics/tests only (does not leak backend to callers)
  USE_FIRESTORE,
  USE_D1,
};
