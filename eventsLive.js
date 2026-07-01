/* =============================================================================
 * eventsLive.js — LIVE beginner-event feed from the MasterCalendar API
 * =============================================================================
 * Server-side only. Fetches ALL pages of the beginnerFriendly SUPERSET near
 * Boston from our own MasterCalendar/TangoTiempo backend (this set already
 * includes the forBeginners events; each occurrence carries BOTH flags so the
 * /events page can split into tiers), expands recurring MASTERS (RRULE strings)
 * into real dated occurrences within a "next 2 weeks" window, normalizes + sorts
 * them, and caches the result in-memory (~15 min TTL).
 *
 * Beginner flags are resolved per-flag OVERRIDE-WINS (consistent with
 * tangotiempo.js): an *Override field, when present (!= null), beats the base
 * field; otherwise the base field is used.
 *
 * `rrule` is the ONLY npm dep used here, and ONLY server-side. Node 18+ ships a
 * global `fetch`, so no HTTP client is needed.
 *
 * Public API:
 *   getLiveEvents() -> Promise<{ events, live, window? }>   (NEVER throws)
 *     success:  { events:[…normalized occurrences…], live:true,
 *                 window:{ start, end } }
 *     failure:  { events:[], live:false }   (network / non-200 / parse error)
 * ========================================================================== */

'use strict';

const { rrulestr } = require('rrule');

const API_BASE = 'https://calendarbeaf-prod.azurewebsites.net/api/events';
const CACHE_TTL_MS = 15 * 60 * 1000; // ~15 minutes
const PAGE_LIMIT = 500;              // API caps at 500
const MAX_PAGES = 20;                // safety valve against runaway pagination

// Boston-ish geo search (same defaults the app already uses elsewhere).
const GEO = { lat: '42.3601', lng: '-71.0589', radius: '50mi' };

// ---- in-memory cache (module-level variable + timestamp) --------------------
let _cache = null;   // last SUCCESSFUL { events, live, window }
let _cacheAt = 0;    // Date.now() of that success

// Window = today 00:00 (local) → today + 14 days (next 2 weeks). Widened from 7
// days so upcoming beginner COURSES that start next week (e.g. a Thursday course
// whose first class is 8 days out) are caught instead of missed.
function computeWindow() {
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + 14 * 24 * 60 * 60 * 1000);
  return { windowStart, windowEnd };
}

// Fetch EVERY page of the beginnerFriendly SUPERSET in the window (this set
// includes the forBeginners events; splitting by flag happens on the /events
// page). Throws on any non-200 / network / parse problem (caught by buildLive
// → { live:false }).
async function fetchAllPages(windowStart, windowEnd) {
  const all = [];
  let page = 1;
  let pages = 1;
  do {
    const params = new URLSearchParams({
      appId: '1',
      useGeoSearch: 'true',
      lat: GEO.lat,
      lng: GEO.lng,
      radius: GEO.radius,
      beginnerFriendly: 'true',
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      limit: String(PAGE_LIMIT),
      page: String(page),
    });
    const resp = await fetch(API_BASE + '?' + params.toString());
    if (!resp || !resp.ok) throw new Error('MasterCalendar API status ' + (resp && resp.status));
    const json = await resp.json();
    const events = Array.isArray(json && json.events) ? json.events : [];
    all.push(...events);
    pages = (json && json.pagination && json.pagination.pages) || 1;
    page += 1;
  } while (page <= pages && page <= MAX_PAGES);
  return all;
}

// Expand ONE API event into the occurrence Dates that fall inside the window.
//   - master w/ recurrenceRule (RRULE): anchor DTSTART = event.startDate,
//     preserve time-of-day, take .between(windowStart, windowEnd, true).
//   - one-off (no recurrenceRule): include if startDate is in-window.
// Never throws; a bad RRULE degrades to the single in-window startDate (if any).
function expandOccurrences(ev, windowStart, windowEnd) {
  const out = [];
  const anchor = ev && ev.startDate ? new Date(ev.startDate) : null;
  if (!anchor || isNaN(anchor.getTime())) return out;

  if (ev.recurrenceRule) {
    try {
      // rrulestr honors an explicit dtstart option even when the RRULE string
      // omits DTSTART; time-of-day comes from the anchor, so occurrences keep it.
      const rule = rrulestr(ev.recurrenceRule, { dtstart: anchor });
      const occ = rule.between(windowStart, windowEnd, true);
      occ.forEach((d) => out.push(new Date(d)));
      return out;
    } catch (e) {
      // fall through to the one-off treatment below
    }
  }
  if (anchor >= windowStart && anchor <= windowEnd) out.push(anchor);
  return out;
}

// Loosely coerce an API flag to boolean (handles true / "true" / 1 / "1").
function truthy(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

// Resolve a single beginner flag PER-FLAG OVERRIDE-WINS (consistent with
// tangotiempo.js): if the override field is present (!= null), it decides;
// otherwise fall back to the base field. So the feed is correct whether or not
// the API bakes overrides into the base fields.
function effectiveFlag(base, override) {
  return override != null ? truthy(override) : truthy(base);
}

// Normalize one occurrence to the shape the /events page + /api/events-live use.
function normalize(ev, occDate) {
  const id = ev._id || '';
  return {
    id,
    url: 'https://tangotiempo.com/event/' + id,
    shortName: ev.shortName || ev.title || '',
    orgName: ev.ownerOrganizerName || '',
    date: occDate.toISOString(),
    venueName: ev.venueName || '',
    category: ev.categoryFirst || '',
    image: ev.eventImage || ev.featuredImage || ev.fallbackImageUrl || null,
    // Store the EFFECTIVE booleans (override-wins) — these drive the /events
    // tier split.
    forBeginners: effectiveFlag(ev.forBeginners, ev.forBeginnersOverride),
    beginnerFriendly: effectiveFlag(ev.beginnerFriendly, ev.beginnerFriendlyOverride),
  };
}

// Build the live feed from scratch (fetch → expand → normalize → sort).
async function buildLive() {
  try {
    const { windowStart, windowEnd } = computeWindow();
    const raw = await fetchAllPages(windowStart, windowEnd);
    const occurrences = [];
    for (const ev of raw) {
      // Defensive: skip junk with neither a title nor a short name.
      if (!ev || (!ev.title && !ev.shortName)) continue;
      const dates = expandOccurrences(ev, windowStart, windowEnd);
      for (const d of dates) {
        const norm = normalize(ev, d);
        if (!norm.id || !norm.date) continue; // skip cards with no id/date
        occurrences.push(norm);
      }
    }
    occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      events: occurrences,
      live: true,
      window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    };
  } catch (e) {
    // ANY failure (network, non-200, parse) → empty + not-live. Never throw.
    return { events: [], live: false };
  }
}

// Cached entry point. Serves the last SUCCESSFUL build for ~15 min; only a
// success is cached, so a transient failure retries on the next call.
async function getLiveEvents() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  const result = await buildLive();
  if (result.live) {
    _cache = result;
    _cacheAt = now;
  }
  return result;
}

module.exports = { getLiveEvents, expandOccurrences, computeWindow };
