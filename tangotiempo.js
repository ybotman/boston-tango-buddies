/* =============================================================================
 * tangotiempo.js — server-side TangoTiempo event fetch helper (zero-dependency)
 * =============================================================================
 * Node 18+ ships a global `fetch`, so this module needs no npm install.
 *
 * Public API:
 *   extractTtId(idOrUrl)          -> 24-hex id string | null
 *   fetchTangoTiempoEvent(idOrUrl)-> normalized event object | null (never throws)
 *
 * A TangoTiempo event URL looks like https://tangotiempo.com/event/<24-hex-id>.
 * The public JSON API is  GET https://tangotiempo.com/api/events/id/<id>.
 * ========================================================================== */

'use strict';

const HEX24 = /[0-9a-fA-F]{24}/;

// Loosely coerce an API flag to boolean (handles true / "true" / 1 / "1").
function truthy(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

// Compute ONE normalized beginner-friendly boolean from the TangoTiempo JSON.
// The API may carry base flags (beginnerFriendly / forBeginners) and override
// flags (beginnerFriendlyOverride / forBeginnersOverride). Overrides WIN when
// present; otherwise fall back to the base flags. True if ANY applicable flag is
// true. Missing everything => false (callers may default seeded events to true).
function normalizeBeginnerFriendly(j) {
  const hasOverride =
    j.beginnerFriendlyOverride != null || j.forBeginnersOverride != null;
  if (hasOverride) {
    return truthy(j.beginnerFriendlyOverride) || truthy(j.forBeginnersOverride);
  }
  return truthy(j.beginnerFriendly) || truthy(j.forBeginners);
}

// Accept a full https://tangotiempo.com/event/<id> URL OR a bare id; return the
// first 24-hex run found (lower-cased), or null if there isn't one.
function extractTtId(idOrUrl) {
  const m = String(idOrUrl == null ? '' : idOrUrl).match(HEX24);
  return m ? m[0].toLowerCase() : null;
}

// Fetch + normalize a single TangoTiempo event. Returns null on ANY problem
// (bad id, network error, non-200, unparseable JSON) — never throws upward.
async function fetchTangoTiempoEvent(idOrUrl) {
  try {
    const ttId = extractTtId(idOrUrl);
    if (!ttId) return null;
    const resp = await fetch('https://tangotiempo.com/api/events/id/' + ttId);
    if (!resp || !resp.ok) return null;
    const j = await resp.json();
    if (!j || typeof j !== 'object') return null;
    return {
      ttId,
      url: 'https://tangotiempo.com/event/' + ttId,
      shortName: j.shortName || '',
      orgName: j.ownerOrganizerName || '',
      title: j.title || '',
      startDate: j.startDate || '',
      venueName: j.venueName || '',
      category: j.categoryFirst || '',
      // eventImage is preferred; fall back through featured/fallback, else null.
      // (fallbackImageUrl can be a site-relative path — callers hide broken imgs.)
      image: j.eventImage || j.featuredImage || j.fallbackImageUrl || null,
      // Single normalized beginner-friendly flag (overrides win; any "for/friendly"
      // flag true => true). Drives the /events beginner-only listing.
      beginnerFriendly: normalizeBeginnerFriendly(j),
    };
  } catch (e) {
    return null;
  }
}

module.exports = { fetchTangoTiempoEvent, extractTtId };
