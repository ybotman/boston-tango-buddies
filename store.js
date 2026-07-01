/* =============================================================================
 * store.js — THE ONLY DATA-ACCESS MODULE (the thin, swappable data layer)
 * =============================================================================
 *
 * Tango Buddy POC — env-gated DUAL BACKEND (chosen once, at runtime):
 *
 *   1) FIRESTORE  — used when the Firebase service-account envs are present
 *      (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).
 *      `firebase-admin` is required LAZILY, only on that path, so local dev
 *      never needs it installed. Collections:
 *        newbies, volunteers, organizers, studios, events, checkins, threads, messages, meta
 *
 *   2) LOCAL JSON — the default (no Firebase envs): reads/writes poc/data/db.json
 *      with Node's built-in `fs`. Zero dependencies, unchanged local behavior.
 *
 * >>> THIS FILE IS THE ONLY THING THAT KNOWS WHICH BACKEND IS IN USE. <<<
 * Everything above store.js (server.js, the pages, the token/tb_token flow) is
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
 *   checkIn(newbieId, eventId, status) · listCheckinsForNewbie(newbieId)
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
 *   event     { id, title, type, date, time, location, organizerId, link, source, demo, createdAt }
 *   checkin   { id, newbieId, eventId, status, when }   status: 'going' | 'went'
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

// Decide (once, cached) where writes go. Never write to DB_PATH on Vercel — its
// filesystem is read-only. Off Vercel, write to DB_PATH exactly as before, unless
// it happens to be non-writable (then fall back to /tmp too).
let _writePath = null;
function writePath() {
  if (_writePath) return _writePath;
  if (ON_VERCEL) { _writePath = TMP_PATH; return _writePath; }
  try {
    fs.accessSync(DB_PATH, fs.constants.W_OK);
    _writePath = DB_PATH;
  } catch (e) {
    _writePath = TMP_PATH;
  }
  return _writePath;
}

function readFile() {
  let raw = null;
  // Prefer a writable copy in /tmp if one exists (a warm Vercel instance that has
  // already taken a write); otherwise read the bundled seed at DB_PATH.
  try { raw = fs.readFileSync(TMP_PATH, 'utf8'); } catch (e) { raw = null; }
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

const backend = USE_FIRESTORE ? firestoreBackend : jsonBackend;

/* ---------- public API (all async) ----------------------------------------- */

async function addNewbie(data) {
  const newbie = {
    id: id('n'),
    // A random device token = the newbie's light identity (no login). The client
    // stores it in localStorage (tb_token) for the with-token home on return.
    token: id('tok'),
    name: (data.name || '').trim(),
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

async function addVolunteer(data) {
  const volunteer = {
    id: id('v'),
    name: (data.name || '').trim(),
    contact: (data.contact || '').trim(),
    area: (data.area || '').trim(),
    availability: (data.availability || '').trim(),
    note: (data.note || '').trim(),
    createdAt: new Date().toISOString(),
  };
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
  return all.slice().sort((a, b) =>
    ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || '')));
}

async function addEvent(data) {
  const event = {
    id: id('e'),
    title: (data.title || '').trim(),
    type: (data.type || '').trim(),
    date: (data.date || '').trim(),
    time: (data.time || '').trim(),
    location: (data.location || '').trim(),
    organizerId: (data.organizerId || '').trim() || null,
    link: (data.link || '').trim(),
    source: (data.source || '').trim(),
    demo: data.demo === true || data.demo === 'true',
    createdAt: new Date().toISOString(),
  };
  await backend.set('events', event.id, event);
  return event;
}

async function updateEvent(eventId, data) {
  const event = await backend.get('events', eventId);
  if (!event) return null;
  ['title', 'type', 'date', 'time', 'location', 'link'].forEach((k) => {
    if (data[k] !== undefined) event[k] = String(data[k]).trim();
  });
  if (data.organizerId !== undefined) event.organizerId = String(data.organizerId).trim() || null;
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

async function checkIn(newbieId, eventId, status) {
  const checkin = {
    id: id('c'),
    newbieId,
    eventId,
    status: status === 'went' ? 'went' : 'going',
    when: new Date().toISOString(),
  };
  await backend.set('checkins', checkin.id, checkin);
  return checkin;
}

async function listCheckinsForNewbie(newbieId) {
  const all = await backend.all('checkins');
  return all
    .filter((c) => c.newbieId === newbieId)
    .sort((a, b) => b.when.localeCompare(a.when));
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
};
