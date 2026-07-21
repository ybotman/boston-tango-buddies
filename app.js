/* =============================================================================
 * server.js — Tango Buddy POC (local, free, zero-dependency demo)
 * =============================================================================
 * Runs on Node's built-in `http` only. No npm install, no framework, no cloud.
 *   $ cd poc && node server.js   ->   http://localhost:3000
 *
 * All data access goes through store.js (the thin, swappable data layer).
 * This file never touches db.json directly — see store.js.
 * ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const store = require('./store');
const { fetchTangoTiempoEvent } = require('./tangotiempo');
const { getLiveEvents } = require('./eventsLive');

// Version comes straight from package.json (zero-dependency, read once at start).
const VERSION = require('./package.json').version;

// V1.0.0 (C2): the ≡ More drawer is hidden at launch. Flip to true to restore it —
// the drawer implementation is retained in full, this is the only switch.
const DRAWER_ENABLED = false;

const PORT = process.env.PORT || 3000;
const ASSETS_DIR = path.join(__dirname, 'assets');

// Admin gate for the public deploy. If ADMIN_PASS is UNSET (local dev), /admin
// stays wide open. If set, /admin (+ its POST routes) require the passphrase —
// supplied once via ?pass=… (which drops a cookie) or the cookie thereafter.
// Newbie/token flows are never gated (no login, by design).
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_COOKIE = 'tb_admin';

// V1.1.0 (D5): a SECOND, LOWER access tier. BUDDY_PASS unlocks /volunteer only.
// ADMIN_PASS is a superset — it opens /volunteer too, so Toby carries one phrase.
// The cookies are deliberately DISTINCT: a buddy must never be able to reach
// /admin, because /admin lists every newcomer's name and phone number and Toby
// hands the buddy phrase out freely to prospective volunteers.
const BUDDY_PASS = process.env.BUDDY_PASS || '';
const BUDDY_COOKIE = 'tb_buddy';

// 🔴 The cookie split alone does NOT prevent escalation. adminOK() also accepts
// the phrase straight off ?pass=, so if BUDDY_PASS and ADMIN_PASS hold the SAME
// string, any volunteer handed the buddy phrase can open /admin?pass=<phrase>
// and get the full operator console. Fail loudly rather than serve that.
if (BUDDY_PASS && ADMIN_PASS && BUDDY_PASS === ADMIN_PASS) {
  throw new Error(
    'BUDDY_PASS must not equal ADMIN_PASS: identical values let any buddy reach '
    + '/admin via ?pass= and read every newcomer\'s contact details. '
    + 'Set BUDDY_PASS to a different phrase.'
  );
}

/* ---------- tiny helpers ---------------------------------------------------- */

// Escape user-supplied text before dropping it into HTML (demo-grade XSS guard).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- V1.1.0 (D7): server-side validation ------------------------------
 * There was none, despite a comment claiming otherwise, and a blank POST created
 * a real row. These helpers are deliberately tiny and shared, so every write path
 * rejects the same way and no endpoint gets forgotten.
 *
 * NOTE: validation applies to NEW writes only. It must never be applied
 * retroactively to the seven backfilled historical records, which legitimately
 * lack fields nobody ever asked them for. */

// A checkbox is "on" from a plain form post, true/'true' from JSON clients.
function isChecked(v) {
  return v === true || v === 'true' || v === 'on' || v === 'yes' || v === '1';
}

// Returns a list of human-readable missing things, e.g. ["your name"].
function requireFields(body, specs) {
  const missing = [];
  specs.forEach(([key, label]) => {
    if (!String(body[key] == null ? '' : body[key]).trim()) missing.push(label);
  });
  return missing;
}

// Render a validation flash back on the form page. Escaped: the string arrives
// off the query string, so it is attacker-controllable even though we authored
// the only messages that legitimately land here.
function flashNotice(flash) {
  const msg = String(flash == null ? '' : flash).trim();
  if (!msg || msg === 'thanks') return '';
  return `<p class="promise" role="alert"><b>${esc(msg)}</b></p>`;
}

// Reject a bad POST without writing anything. JSON clients get a 400 they can
// show inline; plain form posts bounce back to the page with a readable flash.
function rejectPost(req, res, backTo, problems) {
  const msg = `Please add ${problems.join(', ')}.`;
  if ((req.headers.accept || '').includes('application/json')) {
    return sendJson(res, 400, { error: msg, missing: problems });
  }
  return redirect(res, `${backTo}?flash=${encodeURIComponent(msg)}`);
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/html; charset=utf-8' });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

// Parse a urlencoded POST body into an object.
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      const params = new URLSearchParams(data);
      const out = {};
      for (const [k, v] of params) out[k] = v;
      resolve(out);
    });
  });
}

// Parse the Cookie header into a plain object.
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

// Admin auth check. Open when ADMIN_PASS is unset (local dev); otherwise the
// passphrase must arrive via the cookie or a matching ?pass= query param.
function adminOK(req, url) {
  if (!ADMIN_PASS) return true;
  const c = parseCookies(req);
  if (c[ADMIN_COOKIE] && c[ADMIN_COOKIE] === ADMIN_PASS) return true;
  const q = url && url.searchParams ? url.searchParams.get('pass') : null;
  return !!(q && q === ADMIN_PASS);
}
// NOTE: adminOK deliberately never consults BUDDY_COOKIE or BUDDY_PASS. That
// one-way relationship IS the access split — do not "tidy" it into a shared
// helper.

// V1.1.0 (D5): buddy-tier auth for /volunteer. Mirrors adminOK's convention.
// Fallback chain: BUDDY_PASS if set -> else ADMIN_PASS -> else open (local dev).
// Admin is a superset, so a valid ADMIN cookie/param also opens /volunteer.
function buddyOK(req, url) {
  // Admin is a superset: a valid admin cookie/param always opens /volunteer.
  if (ADMIN_PASS && adminOK(req, url)) return true;
  // No buddy phrase configured: admin-only if ADMIN_PASS is set (already checked
  // above, so this is a rejection), wide open if neither is set (local dev).
  if (!BUDDY_PASS) return !ADMIN_PASS;
  const c = parseCookies(req);
  if (c[BUDDY_COOKIE] && c[BUDDY_COOKIE] === BUDDY_PASS) return true;
  const q = url && url.searchParams ? url.searchParams.get('pass') : null;
  return !!(q && q === BUDDY_PASS);
}

/* ---------- shared chrome (warm palette: terracotta/coral + cream + amber) --- */

// One-line social description reused for <meta description> + Open Graph. Kept
// deliberately money-free (no pricing/payments/$ language) since it renders on
// every page, including /coming, /events and /ideas.
const SITE_DESC = 'Boston Tango Buddies — a warm on-ramp for tango newcomers in Boston. '
  + 'We pair you with a buddy so you never learn alone.';

// V1.0.0 — the public origin. Canonical URLs and the sitemap are ALWAYS emitted on
// the apex: never www., never *.vercel.app (duplicate-content + it leaks the host).
const SITE_ORIGIN = 'https://bostontangobuddies.com';

// The ONLY routes that may be crawled/listed. Deliberately excludes /volunteer
// (a personal-details capture form) and every page that renders a newcomer's
// name, contact or messages: /admin /social /chat /updates /ideas /todo /more.
//
// /welcome is NOT here. It is becoming the personal post-signup home (V1.1.0 D3)
// and will carry a WhatsApp group invite. Invite links are a permanent open door
// — anyone holding the URL joins, no approval — so an indexed page carrying one
// gets crawled and the group gets scraped. A page with personal content on it is
// not a landing page and must never be indexable.
const PUBLIC_ROUTES = ['/', '/signup', '/events', '/lessons'];

// V1.1.0 (D6a) — the community room. In-app chat is gone; we point at a group
// that already exists.
//
// 🔴 NEVER put this URL in any page's markup. A WhatsApp group invite is a
// PERMANENT OPEN DOOR: anyone holding the URL joins, with no approval, forever.
// It is served ONLY by /api/me behind a valid device token (see the /group page
// and the /welcome known state) — not as an href, not inside an inline script,
// not hidden with CSS. noindex does not stop scrapers; absence does.
//
// 2026-07-21: repointed to a DIFFERENT group. The old link was
// "Tango Practice Adventurers"; this one is "Boston Tango Newbies". Any copy
// naming the group must use the new name.
const WHATSAPP_GROUP_NAME = 'Boston Tango Newbies';
const WHATSAPP_GROUP_URL = 'https://chat.whatsapp.com/HfrfDUGFzvL31DeWD4WWgC';

/* Indexability is FAIL-CLOSED (V1.0.0, C5). Every page is noindex,nofollow unless
 * it explicitly passes `index: true` — so a page added later is private by default
 * and someone has to opt IN to publishing it. This is deliberate: /admin, /social,
 * /chat and the ideas/updates/todo pages render newcomers' names and contact
 * details, and those must never reach a search index. When opting a page in, pass
 * `path` too so it gets a canonical URL on the apex. */
function page(title, body, opts) {
  opts = opts || {};
  const robots = opts.index ? 'index,follow' : 'noindex,nofollow';
  const canonical = opts.index && opts.path
    ? `\n<link rel="canonical" href="${esc(SITE_ORIGIN + opts.path)}" />` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<!-- Boston Tango Buddies v${esc(VERSION)} -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="${robots}" />${canonical}
<title>${esc(title)}</title>
<meta name="description" content="${esc(SITE_DESC)}" />
<meta name="theme-color" content="#c85a3c" />
<!-- Open Graph / social share (image points at the hero; degrades gracefully if absent) -->
<meta property="og:title" content="Boston Tango Buddies" />
<meta property="og:description" content="${esc(SITE_DESC)}" />
<meta property="og:image" content="/assets/hero.png" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Boston Tango Buddies" />
<!-- Favicon + PWA add-to-home-screen. Both files are optional; server serves 404
     gracefully and the browser simply skips a missing icon (no error). -->
<link rel="icon" href="/assets/icon.png" />
<link rel="apple-touch-icon" href="/assets/icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<style>
  :root{
    --ink:#2a1a12; --terra:#c85a3c; --terra-d:#9e3f27; --coral:#e08767;
    --cream:#fff6ee; --amber:#e6a642; --soft:#7a5c4a; --line:#efdccb;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:linear-gradient(165deg,#fff6ee 0%,#ffe8d8 100%);
    color:var(--ink); -webkit-font-smoothing:antialiased;
    min-height:100dvh; padding:22px 16px calc(30px + env(safe-area-inset-bottom));
  }
  .wrap{max-width:${opts.wide ? '960px' : '480px'};margin:0 auto}
  a{color:var(--terra-d)}
  .badge{display:inline-block;font-size:13px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--terra);font-weight:700;margin-bottom:10px}
  h1{font-size:29px;line-height:1.14;margin:0 0 6px;font-weight:800}
  h1 .accent{color:var(--terra)}
  .lede{font-size:17px;line-height:1.5;color:var(--soft);margin:0 0 18px}
  .hero{border-radius:18px;overflow:hidden;margin:0 0 16px;border:1px solid var(--line);
    /* graceful CSS fallback shown when /assets/hero.png is missing */
    background:linear-gradient(135deg,var(--coral),var(--amber));
    min-height:150px;display:flex;align-items:flex-end}
  .hero img{width:100%;display:block}
  .hero .fallback{padding:16px 18px;color:#fff;font-weight:800;font-size:20px;
    text-shadow:0 1px 6px rgba(0,0,0,.25)}
  .card{background:#fff;border:1px solid var(--line);border-radius:18px;
    padding:20px 18px;box-shadow:0 10px 30px rgba(158,63,39,.09);margin-bottom:16px}
  .promise{font-size:14.5px;line-height:1.55;color:var(--soft);
    background:#fff2e8;border:1px solid #f6dcc9;border-radius:12px;padding:12px 14px;margin:0 0 18px}
  .promise b{color:var(--ink)}
  label.fld{display:block;font-weight:700;font-size:14px;margin:16px 0 7px}
  label.fld:first-of-type{margin-top:0}
  input[type=text],input[type=email],input[type=tel],select,textarea{
    width:100%;font-size:17px;padding:13px 14px;border:1.5px solid var(--line);
    border-radius:12px;background:#fffdfb;color:var(--ink);font-family:inherit}
  textarea{min-height:70px;resize:vertical}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--terra)}
  .hint{font-size:12.5px;color:#a98a76;margin:6px 2px 0}
  .consent{display:flex;gap:10px;align-items:flex-start;margin-top:18px;
    background:#fff2e8;border:1px solid #f6dcc9;border-radius:12px;padding:12px 14px}
  .consent input{margin-top:3px;width:20px;height:20px;flex:0 0 auto}
  .consent label{font-size:14px;line-height:1.45;color:var(--ink);font-weight:600}
  .submit{width:100%;font-size:18px;font-weight:800;color:#fff;background:var(--terra);
    border:none;border-radius:14px;padding:16px;margin-top:20px;cursor:pointer}
  .submit:active{background:var(--terra-d)}
  .foot{text-align:center;color:#b89a86;font-size:12.5px;margin-top:18px;line-height:1.5}
  .nav{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin:2px 0 18px;font-size:14px}
  .nav a{font-weight:700;text-decoration:none}
  .big{font-size:46px;line-height:1;margin:0 0 12px;text-align:center}
  /* teacher cards */
  .teacher h3{margin:0 0 4px;font-size:18px}
  .teacher .studio{color:var(--terra-d);font-weight:700;font-size:14px;margin:0 0 8px}
  .teacher p{color:var(--soft);font-size:14.5px;line-height:1.5;margin:0 0 12px}
  .ctas{display:flex;gap:8px;flex-wrap:wrap}
  .ctas a{flex:1;min-width:120px;text-align:center;text-decoration:none;font-weight:700;
    font-size:14px;padding:11px 8px;border-radius:11px;background:var(--terra);color:#fff}
  .ctas a.alt{background:#fff;color:var(--terra-d);border:1.5px solid var(--line)}
  .ctas button{flex:1;min-width:120px;min-height:44px;text-align:center;font-weight:700;
    font-size:14px;padding:11px 8px;border-radius:11px;background:var(--terra);color:#fff;
    border:none;cursor:pointer;font-family:inherit}
  .ctas button:active{background:var(--terra-d)}
  .ctas button.alt{background:#fff;color:var(--terra-d);border:1.5px solid var(--line)}
  .quiet{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin:6px 0 4px;font-size:14px}
  .quiet a{font-weight:700;text-decoration:none}
  .demo-tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;color:#9e3f27;background:#ffe3d0;border-radius:6px;padding:2px 7px;margin-left:6px}
  /* admin tables */
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--soft);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
  .pill{display:inline-block;font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:20px}
  .pill.new{background:#ffe3d0;color:#9e3f27}
  .pill.matched{background:#dff0dc;color:#2f6b2a}
  .pill.no{background:#f3e0e0;color:#a02c2c}
  .pill.yes{background:#dff0dc;color:#2f6b2a}
  .match-form{display:flex;gap:6px}
  .match-form select{padding:8px;font-size:13px}
  .match-form button{background:var(--terra);color:#fff;border:none;border-radius:9px;
    padding:8px 12px;font-weight:700;cursor:pointer;font-size:13px}
  .empty{color:#a98a76;font-style:italic;padding:14px 4px}
  .scroll{overflow-x:auto}
  /* chat / social */
  .thread{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;
    max-height:52vh;overflow-y:auto;padding:4px 2px}
  .msg{max-width:82%;padding:9px 13px;border-radius:15px;font-size:15px;line-height:1.4;
    background:#fff2e8;border:1px solid #f6dcc9;align-self:flex-start}
  .msg.me{align-self:flex-end;background:var(--terra);color:#fff;border-color:var(--terra-d)}
  .msg .who{display:block;font-size:11.5px;font-weight:700;letter-spacing:.03em;
    opacity:.75;margin-bottom:2px}
  .msg .when{display:block;font-size:10.5px;opacity:.6;margin-top:3px}
  .composer{display:flex;gap:8px;margin-top:14px}
  .composer input[type=text]{flex:1}
  .composer button{background:var(--terra);color:#fff;border:none;border-radius:12px;
    padding:0 18px;font-weight:800;font-size:16px;cursor:pointer}
  .composer button:active{background:var(--terra-d)}
  .switcher{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:6px}
  .switcher > div{flex:1;min-width:140px}
  .seg{display:inline-flex;border:1.5px solid var(--line);border-radius:11px;overflow:hidden}
  .seg a{padding:9px 14px;text-decoration:none;font-weight:700;font-size:14px;color:var(--terra-d);background:#fff}
  .seg a.on{background:var(--terra);color:#fff}
  /* coming-soon cards */
  .soon{border:1px solid var(--line);border-radius:16px;padding:18px;background:#fff;margin-bottom:14px;
    box-shadow:0 8px 22px rgba(158,63,39,.07)}
  .soon .ico{font-size:30px;line-height:1;margin-bottom:8px}
  .soon h3{margin:0 0 6px;font-size:19px}
  .soon p{margin:0;color:var(--soft);font-size:14.5px;line-height:1.5}
  .soon .tease{display:inline-block;margin-top:10px;font-size:11.5px;font-weight:700;
    letter-spacing:.08em;text-transform:uppercase;color:var(--terra);background:#ffe3d0;
    border-radius:20px;padding:3px 11px}
  /* footer link groups — shared by the bottom drawer + the no-JS fallback */
  .acts{display:flex;gap:12px;flex-wrap:wrap}
  .acts a{flex:1 1 46%;min-width:150px;min-height:48px;display:flex;
    align-items:center;justify-content:center;text-align:center;text-decoration:none;
    font-weight:800;font-size:16px;border-radius:14px;padding:13px 14px}
  .acts a.buddy{background:var(--terra);color:#fff}
  .acts a.buddy:active{background:var(--terra-d)}
  .acts a.admin{background:#fff;color:var(--terra-d);border:1.5px solid var(--line)}
  .meta{display:flex;gap:8px 14px;flex-wrap:wrap;align-items:center;
    justify-content:center;margin-top:16px;font-size:14px;color:var(--soft)}
  .meta .ver{font-weight:800;color:var(--terra-d)}
  .meta a{min-height:44px;display:inline-flex;align-items:center;
    padding:6px 6px;font-weight:700;text-decoration:none;color:var(--terra-d)}
  .meta .dot{color:var(--line)}
  /* no-JS fallback footer (rendered only inside <noscript>) */
  .sitefoot{margin-top:26px;border-top:1px solid var(--line);padding-top:18px}
  /* ---- Bottom drawer / sheet (mobile-native) --------------------------------
     Replaces the old static footer: a slim handle pinned to the bottom of the
     viewport that slides a panel up. NOTE: these drawer links (Admin etc.) will
     later be GATED/AUTHENTICATED — the handle stays public, the panel won't. */
  body{padding-bottom:calc(64px + env(safe-area-inset-bottom))} /* room for the handle */
  .tb-handle{
    position:fixed;left:0;right:0;bottom:0;z-index:61;
    display:flex;align-items:center;justify-content:center;gap:8px;
    border:none;border-top:1px solid var(--line);
    background:#fff;color:var(--terra-d);font-weight:800;font-size:15px;font-family:inherit;
    padding:12px 14px calc(12px + env(safe-area-inset-bottom));min-height:48px;
    box-shadow:0 -6px 20px rgba(158,63,39,.10);cursor:pointer;
    transition:opacity .2s ease}
  .tb-scrim{position:fixed;inset:0;z-index:62;background:rgba(42,26,18,.45);
    opacity:0;pointer-events:none;transition:opacity .28s ease}
  .tb-panel{
    position:fixed;left:0;right:0;bottom:0;z-index:63;background:#fff;
    border-top-left-radius:20px;border-top-right-radius:20px;border-top:1px solid var(--line);
    box-shadow:0 -14px 40px rgba(158,63,39,.18);max-height:80vh;overflow-y:auto;
    padding:8px 18px calc(22px + env(safe-area-inset-bottom));
    transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1)}
  .tb-grip{width:44px;height:5px;border-radius:3px;background:var(--line);
    margin:6px auto 14px;cursor:pointer}
  .tb-drawer.open .tb-scrim{opacity:1;pointer-events:auto}
  .tb-drawer.open .tb-panel{transform:translateY(0)}
  .tb-drawer.open .tb-handle{opacity:0;pointer-events:none}
  @media(max-width:600px){.grid{grid-template-columns:1fr!important}}
</style>
</head>
<body><div class="wrap">
<!-- V1.0.0 (C2): nav trimmed to three. Social was removed from the nav but /social
     stays LIVE by direct URL (hide, not delete). Chat went further — see C3. -->
<div class="nav">
  <a href="/signup">Learn tango</a>
  <a href="/events">Events</a>
  <a href="/lessons">Lessons</a>
  <a href="/group">Newbies group</a>
</div>
${body}
</div>
${siteFooter()}
${bottomDrawer()}
</body></html>`;
}

// Bottom drawer on EVERY page (replaces the old static footer). A slim handle is
// pinned to the bottom of the viewport; tapping it slides a sheet up revealing the
// links. Tapping the scrim / grip / Escape / swipe-down closes it. These links
// (Be a buddy / Admin / Coming / More / Updates / Ideas / To-do) are the primary
// nav for those pages and deliberately live ONLY here — not in the top menu.
// Progressive enhancement: the drawer is `hidden` until JS un-hides it, and a
// <noscript> static footer keeps every link reachable when JS is off.
// NOTE: this drawer will later be GATED/AUTHENTICATED (the handle stays public,
// the panel contents become operator-only).
/* 2026-07-21 — a slim TWO-ITEM footer. This partially reverses D6's "hide the
 * drawer entirely": the drawer stays gone, but these two doors come back.
 *
 * Both destinations are passphrase-gated, so linking them publicly is safe — the
 * gate is the protection, not the obscurity. Nobody is kept out by a missing
 * link; the only person kept out was the volunteer who could not find the door,
 * which is precisely why zero volunteers exist and matching has never once run.
 *
 * Deliberately NOT restoring Coming / More / Updates / Ideas / To-do. */
function siteFooter() {
  return `<div class="wrap"><footer class="sitefoot" style="text-align:center">
    <a href="/volunteer" style="font-weight:700;text-decoration:none">For buddies</a>
    <span class="dot" style="margin:0 10px">·</span>
    <a href="/admin" style="font-weight:700;text-decoration:none">Admin login</a>
  </footer></div>`;
}

function bottomDrawer() {
  // V1.0.0 (C2): the whole drawer is HIDDEN. Toby's call — the launch chrome is the
  // three-item top nav and nothing else. Every link below stays reachable by typing
  // the URL (/volunteer /admin /coming /more /updates /ideas /todo); the accepted
  // consequence is that /admin is now operator-knowledge-only.
  // The implementation below is retained INTACT and dead: restoring the drawer is
  // deleting this one return. The version string it used to show now lives in an
  // HTML comment in page() and in /api/health, so v1.0.0 is still retrievable.
  if (!DRAWER_ENABLED) return '';

  const links = `
    <div class="acts">
      <a class="buddy" href="/volunteer">Be a buddy</a>
      <a class="admin" href="/admin">Admin</a>
      <a class="admin" href="/coming">Coming</a>
      <a class="admin" href="/more">More</a>
    </div>
    <div class="meta">
      <span class="ver">Tango Buddy v${esc(VERSION)}</span>
      <span class="dot">·</span><a href="/updates">Updates</a>
      <span class="dot">·</span><a href="/ideas">Ideas</a>
      <span class="dot">·</span><a href="/todo">To-do</a>
    </div>`;
  return `<div class="tb-drawer" id="tb-drawer" hidden>
  <div class="tb-scrim" id="tb-scrim"></div>
  <button type="button" class="tb-handle" id="tb-handle" aria-expanded="false" aria-controls="tb-panel">≡ More</button>
  <div class="tb-panel" id="tb-panel" role="dialog" aria-modal="false" aria-label="More links">
    <div class="tb-grip" id="tb-grip" title="Close" aria-hidden="true"></div>
    ${links}
  </div>
</div>
<noscript><div class="wrap"><footer class="sitefoot">${links}</footer></div></noscript>
<script>
(function(){
  var d=document.getElementById('tb-drawer'); if(!d) return;
  d.hidden=false; // progressive enhancement: only show the JS drawer when JS runs
  var handle=document.getElementById('tb-handle');
  var scrim=document.getElementById('tb-scrim');
  var grip=document.getElementById('tb-grip');
  var panel=document.getElementById('tb-panel');
  function open(){d.classList.add('open');handle.setAttribute('aria-expanded','true');}
  function close(){d.classList.remove('open');handle.setAttribute('aria-expanded','false');}
  handle.addEventListener('click',open);
  scrim.addEventListener('click',close);
  grip.addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});
  // swipe-down on the panel to dismiss
  var y0=null;
  panel.addEventListener('touchstart',function(e){y0=e.touches[0].clientY;},{passive:true});
  panel.addEventListener('touchend',function(e){
    if(y0==null)return; var dy=e.changedTouches[0].clientY-y0; y0=null;
    if(dy>60&&panel.scrollTop<=0)close();
  },{passive:true});
})();
</script>`;
}

// Hero block: <img> that hides itself if /assets/hero.png is missing, revealing
// the gradient + text fallback underneath (onerror handler, no server check).
function heroBlock() {
  return `<div class="hero">
    <img src="/assets/hero.png" alt="Boston tango" onerror="this.style.display='none'" />
    <div class="fallback">Boston Tango · come dance with us</div>
  </div>`;
}

/* ---------- page: newbie capture / sign-up (GET /signup) --------------------- */
/* v0.7.0 — the QR target. The exact hero copy is preserved. On a successful
 * AJAX sign-up the client saves tb_token, shows a thank-you, then goes to "/"
 * (the smart router renders their home). No-JS falls back to a plain POST that
 * redirects here with ?flash=thanks (a server-rendered thank-you card). */

function signupPage(flash) {
  const platforms = ['Instagram', 'Facebook', 'WhatsApp', 'Phone', 'Email', 'Other'];
  const options = platforms.map((p) => `<option value="${p}">${p}</option>`).join('');
  // Server-rendered thank-you ONLY for the no-JS fallback (a plain POST redirects
  // here with ?flash=thanks). With JS, the client shows its own thank-you screen
  // then routes to "/" — see signupScript() below.
  const thanks = flash === 'thanks'
    ? `<div class="card" style="text-align:center">
         <div class="big">💃🕺</div>
         <h1>You are in!</h1>
         <p class="lede" style="margin-bottom:0">We'll pair you with a buddy and set up your
         <b>free first lesson</b>. Keep this on your phone — next time you visit, you'll see
         what's happening.</p>
       </div>`
    // D7: any other flash is a validation message from a rejected no-JS post.
    // It MUST be shown — a silent bounce back to an identical page reads as the
    // form being broken, and the person just leaves.
    : flashNotice(flash);
  return page('Boston Tango Buddies', `
    <div id="tb-capture">
      <span class="badge">Boston Tango</span>
      <h1>Thanks for scanning. <span class="accent">Want to learn tango?</span></h1>
      <p class="lede">We will set you up with a <b>free first lesson</b> and a <b>tango buddy</b> —
        someone to learn beside you.</p>
      ${heroBlock()}
      ${thanks}
      <div class="card">
        <p class="promise">We are not selling anything. <b>It is all free.</b> We are tango
          enthusiasts who want you to learn, and we will be your buddy along the way.
          We just want you to tango.</p>
        <p class="promise" id="tb-formerr" role="alert" hidden
          style="background:#ffe9e2;border-color:#f3c4b3"></p>
        <form method="POST" action="/api/newbie">
          <label class="fld" for="firstName">First name</label>
          <input id="firstName" name="firstName" type="text" autocomplete="given-name"
            placeholder="First name" required />

          <label class="fld" for="lastName">Last name</label>
          <input id="lastName" name="lastName" type="text" autocomplete="family-name"
            placeholder="Last name" required />

          <label class="fld" for="platform">Best way to reach you</label>
          <select id="platform" name="platform" required>
            <option value="" disabled selected>Pick a platform…</option>
            ${options}
          </select>

          <label class="fld" for="contact">Your handle / number / email</label>
          <input id="contact" name="contact" type="text" placeholder="e.g. @yourname, 617-555-0123, you@email.com" required />

          <label class="fld" for="platform2">A second way, if you have one
            <span style="font-weight:500;color:#a98a76">(optional)</span></label>
          <select id="platform2" name="platform2">
            <option value="" selected>No second method</option>
            ${options}
          </select>
          <input id="contact2" name="contact2" type="text" style="margin-top:8px"
            placeholder="Handle, number or email" />
          <p class="hint">Only if it is easy. One way to reach you is plenty.</p>

          <!-- D1a: wantsBuddy. Deliberately NOT pre-selected and deliberately not
               framed as opting out of the good thing — plenty of people just want to
               know where the beginner-friendly nights are, and that is a completely
               fine thing to want. Required, so we never have to infer it. -->
          <label class="fld">Would you like a tango buddy?</label>
          <div class="consent" style="align-items:flex-start">
            <input id="wantsBuddyYes" name="wantsBuddy" type="radio" value="yes" required />
            <label for="wantsBuddyYes"><b>Yes please</b> — pair me with someone
              who can show me the ropes.</label>
          </div>
          <div class="consent" style="align-items:flex-start">
            <input id="wantsBuddyNo" name="wantsBuddy" type="radio" value="no" />
            <label for="wantsBuddyNo"><b>No thanks</b> — just tell me where the
              beginner-friendly events are. That is genuinely fine.</label>
          </div>

          <label class="fld" for="dancedBefore">Have you danced before?</label>
          <select id="dancedBefore" name="dancedBefore">
            <option value="" selected>Rather not say</option>
            <option value="yes">Yes, some kind of dancing</option>
            <option value="no">No, never</option>
          </select>
          <input id="dancedWhat" name="dancedWhat" type="text" style="margin-top:8px"
            placeholder="If yes — what? salsa, swing, ballroom…" />

          <label class="fld" for="dancedTangoBefore">Have you danced tango before?</label>
          <select id="dancedTangoBefore" name="dancedTangoBefore">
            <option value="" selected>Rather not say</option>
            <option value="yes">Yes, a little</option>
            <option value="no">No, never</option>
          </select>

          <label class="fld" for="origination">How did you find us?</label>
          <select id="origination" name="origination">
            <option value="" disabled selected>Pick one…</option>
            <option value="QR code">QR code</option>
            <option value="A friend">A friend</option>
            <option value="Social media">Social media</option>
            <option value="An event">An event</option>
            <option value="Other">Other</option>
          </select>

          <label class="fld" for="note">Anything you want us to know? <span style="font-weight:500;color:#a98a76">(optional)</span></label>
          <textarea id="note" name="note" placeholder="Never danced, a little nervous, best evenings, etc."></textarea>

          <div class="consent">
            <input id="consent" name="consent" type="checkbox" value="on" required />
            <label for="consent">I'm OK being connected to a local tango buddy.</label>
          </div>

          <button class="submit" type="submit">Yes — sign me up!</button>
        </form>
      </div>
      <p class="foot">Tango Buddy · Boston · a friendly free invitation, nothing more.</p>
    </div>
    <div id="tb-thanks" hidden></div>
    ${signupScript()}
  `, { index: true, path: '/signup' });
}

/* Client script for /signup. Submit -> AJAX POST /api/newbie -> save the minted
 * token to localStorage(tb_token) -> thank-you screen -> "See what's happening"
 * links to "/" (the smart router then renders the with-token home). No-JS falls
 * back to the plain form POST + ?flash=thanks card. Zero-dependency vanilla JS. */
function signupScript() {
  return `<script>
(function(){
  var LSK='tb_token';
  var cap=document.getElementById('tb-capture');
  var thx=document.getElementById('tb-thanks');
  var form=cap?cap.querySelector('form'):null;
  function show(el){if(el)el.hidden=false;} function hide(el){if(el)el.hidden=true;}
  function setToken(t){try{localStorage.setItem(LSK,t);}catch(e){}}
  function shareBtnHtml(){
    return '<button type="button" class="submit" id="tb-share" '+
      'style="background:#fff;color:var(--terra-d);border:1.5px solid var(--line)">Bring a buddy</button>';
  }
  function wireShare(){
    var b=document.getElementById('tb-share'); if(!b) return;
    b.addEventListener('click',function(){
      var url=location.origin+'/signup';
      var data={title:'Boston Tango Buddies',
        text:'Come learn tango with me — Boston Tango Buddies.',url:url};
      if(navigator.share){navigator.share(data).catch(function(){});return;}
      function done(){var t=b.textContent;b.textContent='link copied ✓';
        setTimeout(function(){b.textContent=t;},2000);}
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(url).then(done).catch(function(){prompt('Copy this link:',url);});
      }else{prompt('Copy this link:',url);}
    });
  }
  function showThanks(){
    hide(cap);
    thx.innerHTML='<span class="badge">Boston Tango</span>'
      +'<div class="card" style="text-align:center"><div class="big">💃🕺</div>'
      +'<h1>You\\'re in!</h1>'
      +'<p class="lede">We\\'ll pair you with a buddy and set up your free first lesson. '
      +'Keep this on your phone — next time you visit, you\\'ll see what\\'s happening.</p>'
      +shareBtnHtml()
      +'<p class="foot" style="margin-top:16px"><a href="/" id="tb-continue">See what\\'s happening →</a></p></div>';
    show(thx);wireShare();
    try{window.scrollTo(0,0);}catch(e){}
  }
  if(form){
    form.addEventListener('submit',function(ev){
      ev.preventDefault();
      var body=new URLSearchParams(new FormData(form)).toString();
      fetch('/api/newbie',{method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
        body:body})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d&&d.token){setToken(d.token);showThanks();return;}
          // D7: a rejection is NOT a thank-you. This previously sent anyone whose
          // submission was refused to ?flash=thanks — telling a real person their
          // details were saved when nothing was written. Show what is missing and
          // leave them on their filled-in form.
          if(d&&d.error){
            var box=document.getElementById('tb-formerr');
            if(box){box.textContent=d.error;box.hidden=false;
              try{box.scrollIntoView({block:'center'});}catch(e){}}
            else{alert(d.error);}
            return;
          }
          location.href='/signup';
        }).catch(function(){form.submit();});
    });
  }
})();
</script>`;
}

/* ---------- page: the group interstitial (GET /group) ----------------------- */
/* 2026-07-21. Toby wants the WhatsApp group on the menu. The nav renders on /,
 * /signup, /events and /lessons — all INDEXABLE — so the raw invite must never be
 * the nav target: it would be crawled, harvested, and the newcomers' group fills
 * with spam accounts. An invite URL is a permanent open door, and unlike a
 * password it cannot be rotated without disrupting everyone already inside.
 *
 * So the nav points HERE, and this page is the airlock:
 *   noindex, out of the sitemap, and the invite itself arrives from /api/me
 *   behind a valid device token. A tokenless visitor gets a warm nudge to sign
 *   up and NO invite URL in the markup at all — not hidden, not present.
 *
 * Same protection as the /welcome known state; moving the link must not lose it. */

function groupPage() {
  return page(`Join the ${WHATSAPP_GROUP_NAME}`, `
    <div id="tb-group-known" hidden></div>
    <div id="tb-group-stranger">
      <span class="badge">Boston Tango · The Group</span>
      <h1>The <span class="accent">${esc(WHATSAPP_GROUP_NAME)}</span> group</h1>
      <p class="lede">A WhatsApp room for people who are just finding their way into
        Boston tango. Questions, nerves, which milonga to try first. Nobody bites.</p>
      <div class="card" style="text-align:center">
        <p style="margin:0 0 14px">We keep the invite for people who have signed up, so the
          room stays newcomers and not bots. Sign up and we will bring you straight in.</p>
        <a class="submit" href="/signup"
          style="display:block;text-align:center;text-decoration:none">Get started</a>
        <p class="foot" style="margin-top:16px">Already signed up on this phone? Give it a
          moment — the invite appears here automatically.</p>
      </div>
    </div>
    ${groupStateScript()}
  `);
}

/* The invite is fetched, never rendered server-side. See groupPage's header. */
function groupStateScript() {
  return `<script>
(function(){
  var LSK='tb_token';
  var known=document.getElementById('tb-group-known');
  var stranger=document.getElementById('tb-group-stranger');
  if(!known||!stranger) return;
  var tok; try{tok=localStorage.getItem(LSK);}catch(e){return;}
  if(!tok) return;
  function el(tag,cls,text){var n=document.createElement(tag);
    if(cls)n.className=cls; if(text!=null)n.textContent=text; return n;}
  fetch('/api/me?token='+encodeURIComponent(tok),{headers:{'Accept':'application/json'}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      // No record, or no invite issued: leave the stranger state exactly as it is.
      if(!d||!d.newbie||!d.groupUrl){
        if(d&&!d.newbie){try{localStorage.removeItem(LSK);}catch(e){}}
        return;
      }
      var name=String(d.newbie.name==null?'':d.newbie.name).trim();
      var first=name?name.split(/\\s+/)[0]:'';
      known.appendChild(el('span','badge','Boston Tango · The Group'));
      var h=el('h1'); h.appendChild(document.createTextNode(
        first?('You are in, '+first+'.'):'You are in.'));
      known.appendChild(h);
      known.appendChild(el('p','lede',
        'This is the ${WHATSAPP_GROUP_NAME} room: people who are also just starting, '
        + 'working out which milonga to try and what the codes mean. Say hello when you '
        + 'arrive. Nobody bites, and no question is too basic.'));
      var card=el('div','card');
      var a=el('a',null,'Open the group in WhatsApp');
      a.href=d.groupUrl; a.target='_blank'; a.rel='noopener noreferrer';
      a.className='submit';
      a.style.display='block'; a.style.textAlign='center'; a.style.textDecoration='none';
      card.appendChild(a);
      card.appendChild(el('p','foot',
        'It is the wider community room, not a private chat with your buddy.'));
      known.appendChild(card);
      stranger.hidden=true; known.hidden=false;
    })
    .catch(function(){});
})();
</script>`;
}

/* ---------- the mission copy (V1.1.0 D4b) ----------------------------------- */
/* Toby's four beats. Rendered SERVER-SIDE so a crawler and a JS-less visitor both
 * get real content, and so a curious stranger meets an explanation rather than a
 * form. Shared by "/" and the stranger state of /welcome.
 *
 * Beat 4 ("not about money") deliberately gets its own block and plain sentences:
 * a free stranger offering help reads as a catch until you say there is no catch,
 * so it must not be softened, shortened or moved into the footer. */
function missionBody() {
  return `
    <span class="badge">Boston Tango</span>
    <h1>Tango is wonderful. <span class="accent">It is also intimidating.</span></h1>
    <p class="lede">Both things are true, and anyone who tells you otherwise has forgotten
      their first night. The music is strange, everyone seems to know each other, and there
      are rules nobody writes down.</p>
    ${heroBlock()}
    <h2 class="tier-h" style="font-size:20px;font-weight:800;margin:22px 0 12px">
      Boston Tango · come dance with us</h2>
    <div class="card">
      <p style="margin:0 0 14px">It takes time to learn. That part does not shorten. What
        changes is whether you walk it on your own.</p>
      <p style="margin:0 0 14px"><b>There are people here who want to help you.</b> Not to
        teach you, not to sell you anything: to be the familiar face who tells you which
        milonga is kind on a Tuesday, what the codes mean, and who to say hello to. We pair
        you with one of them, and we point you at the studios, the milongas, the practicas
        and the teachers. Think of us as the map.</p>
      <p class="promise" style="margin:0"><b>This is not about money.</b> We sell nothing.
        We take no cut. We are not a school and we are not anybody's booking agent. We just
        want you to learn tango, from someone, and dance.</p>
    </div>`;
}

/* ---------- page: welcome — ONE PAGE, TWO STATES (V1.2.0 F2d) ---------------- */
/* Supersedes the V1.0.0 C4 front door and the original D2/D3 routing.
 *
 *  STRANGER (no usable token): the mission copy + a warm invitation to sign up.
 *  Deliberately NO form wall — dropping a curious stranger into a form is exactly
 *  the intimidation the mission copy exists to defuse.
 *  KNOWN (valid token): Hello {FirstName} + the personal home (D3, in progress).
 *
 * The stranger state is the SERVER-RENDERED default and the known state is swapped
 * in by JS, because identity lives in localStorage and /welcome must stay a single
 * cacheable page. That ordering is also the safe one: a crawler, a JS-less browser
 * and a stranger all see the same public content, and nothing personal is ever in
 * the markup. /welcome is noindex regardless (Amendment 5). */

function welcomePage() {
  return page('Boston Tango Buddies', `
    <div id="tb-known" hidden></div>
    <div id="tb-stranger">
      ${missionBody()}
      <div class="card" style="text-align:center">
        <p class="lede" style="margin-bottom:14px">Want a buddy of your own?</p>
        <a class="submit" href="/signup"
          style="display:block;text-align:center;text-decoration:none">Get started</a>
        <p class="foot" style="margin-top:16px">Been here before? Your phone should remember you.
          If it doesn't, just <a href="/signup">sign up again</a>.</p>
      </div>
      <p class="foot">Tango Buddy · Boston · a friendly free invitation, nothing more.</p>
    </div>
    ${welcomeStateScript()}
  `);
}

/* Client script for /welcome. Swaps the stranger state for the personal home when
 * a valid device token is present. A stale/unknown token is cleared and the
 * stranger state simply stays — no redirect, because /welcome is now the front
 * door and bouncing someone out of it would loop.
 *
 * The known state is built with DOM methods and textContent for anything
 * user-supplied. The WhatsApp group invite is emitted ONLY here, inside the
 * token branch, so it never appears in markup a crawler or a stranger can read
 * (Amendment 5 — an invite link is a permanent open door for anyone holding it). */
function welcomeStateScript() {
  return `<script>
(function(){
  var LSK='tb_token';
  var known=document.getElementById('tb-known');
  var stranger=document.getElementById('tb-stranger');
  if(!known||!stranger) return;
  var tok; try{tok=localStorage.getItem(LSK);}catch(e){return;}
  if(!tok) return;

  function el(tag,cls,text){
    var n=document.createElement(tag);
    if(cls)n.className=cls;
    if(text!=null)n.textContent=text;   // never innerHTML for user-supplied text
    return n;
  }

  fetch('/api/me?token='+encodeURIComponent(tok),{headers:{'Accept':'application/json'}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      if(!d||!d.newbie){try{localStorage.removeItem(LSK);}catch(e){} return;}
      var name=String(d.newbie.name==null?'':d.newbie.name).trim();
      var first=name?name.split(/\\s+/)[0]:'';

      known.appendChild(el('span','badge','Boston Tango'));
      var h=el('h1'); h.appendChild(document.createTextNode(first?('Hello, '+first):'Welcome back'));
      known.appendChild(h);
      known.appendChild(el('p','lede',
        'Tango is wonderful, and intimidating. Both are true. It takes time, and you do not '
        + 'have to do it alone. No money changes hands here: we sell nothing and take no cut. '
        + 'We just want you dancing.'));

      // Standing action 2 (D4a) — the community room. The URL arrives from
      // /api/me (token-gated) and is never present in this page's source.
      if(d.groupUrl){
        var card=el('div','card');
        card.appendChild(el('h3',null,'Join the ${WHATSAPP_GROUP_NAME}'));
        card.appendChild(el('p',null,
          'The wider community room on WhatsApp, where people finding their way in talk to '
          + 'each other. It is not a private chat with your buddy.'));
        var a=el('a',null,'Open the group in WhatsApp');
        a.href=d.groupUrl;
        a.target='_blank'; a.rel='noopener noreferrer';
        a.className='submit';
        a.style.display='block'; a.style.textAlign='center'; a.style.textDecoration='none';
        card.appendChild(a);
        known.appendChild(card);
      }

      // Standing action 3 (D4a) — the real next step.
      var lessons=el('div','card');
      lessons.appendChild(el('h3',null,'Reach out to a studio'));
      lessons.appendChild(el('p',null,
        'When you are ready for real lessons, the Boston studios that teach beginners are '
        + 'listed with their phone numbers and websites.'));
      var la=el('a',null,'See the studios');
      la.href='/lessons';
      lessons.appendChild(la);
      known.appendChild(lessons);

      // TODO (D3/D4a): events feed with one-tap check-in, plus check-in history
      // rendered FROM THE SNAPSHOT on each row (D4a-i), never a live lookup.

      stranger.hidden=true;
      known.hidden=false;
      try{window.scrollTo(0,0);}catch(e){}
    })
    .catch(function(){});
})();
</script>`;
}

/* ---------- page: the front door (GET /) ------------------------------------ */
/* V1.2.0 (F2d) — SUPERSEDES the V1.0.0 C4 routing (no token -> /signup) and the
 * original D2/D3 routing. There is no form wall at the front door any more.
 *
 *   stranger  -> stays HERE, reading the mission copy. Signup is an invitation,
 *                not a toll gate.
 *   known     -> /welcome, the personal home.
 *
 * ⚠️ DELIBERATE DEVIATION from F2d as written, flagged in PHASE-D-STATUS.md.
 * F2d says "/ routes to /welcome in BOTH cases". Doing that literally would send
 * crawlers from our ONE indexable landing page into /welcome, which is
 * noindex,nofollow by Amendment 5 — deindexing the homepage and undoing the C5
 * work that just shipped. So the stranger STATE is served at "/" rather than
 * redirected to: identical content, same no-form-wall intent, but "/" keeps real
 * indexable copy and only token-holders travel to /welcome. Both pages render the
 * same stranger state, so a direct hit on either behaves the same. */

function rootShell() {
  return page('Boston Tango Buddies', `
    ${missionBody()}
    <div class="card" style="text-align:center">
      <p class="lede" style="margin-bottom:14px">Want a buddy of your own?</p>
      <a class="submit" href="/signup"
        style="display:block;text-align:center;text-decoration:none">Get started</a>
    </div>
    <p class="foot">Tango Buddy · Boston · a friendly free invitation, nothing more.</p>
    ${homeShellScript()}
  `, { index: true, path: '/' });
}

/* Client script for "/" (V1.0.0, C4). Validates the token against /api/me, then:
 * no token -> /signup · valid -> /events · unknown/404 -> clear the token + /signup.
 * Zero-dependency vanilla JS. */
function homeShellScript() {
  return `<script>
(function(){
  var LSK='tb_token';
  var home=document.getElementById('tb-home');
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function getToken(){try{return localStorage.getItem(LSK);}catch(e){return null;}}
  function clearToken(){try{localStorage.removeItem(LSK);}catch(e){}}
  function prettyDate(d){try{var x=(''+d).indexOf('T')>-1?new Date(d):new Date(d+'T00:00:00');
    if(isNaN(x))return d;
    return x.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});}catch(e){return d;}}

  function shareBtnHtml(){
    return '<button type="button" class="submit" id="tb-share" '+
      'style="background:#fff;color:var(--terra-d);border:1.5px solid var(--line)">Bring a buddy</button>';
  }
  function wireShare(){
    var b=document.getElementById('tb-share'); if(!b) return;
    b.addEventListener('click',function(){
      var url=location.origin+'/signup';
      var data={title:'Boston Tango Buddies',
        text:'Come learn tango with me — Boston Tango Buddies.',url:url};
      if(navigator.share){navigator.share(data).catch(function(){});return;}
      function done(){var t=b.textContent;b.textContent='link copied ✓';
        setTimeout(function(){b.textContent=t;},2000);}
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(url).then(done).catch(function(){prompt('Copy this link:',url);});
      }else{prompt('Copy this link:',url);}
    });
  }

  function renderHome(data){
    var n=data.newbie||{}, events=data.events||[], checkins=data.checkins||[];
    var byEvent={}; checkins.forEach(function(c){byEvent[c.eventId]=c.status;});
    var evHtml=events.length?events.map(function(ev){
      var st=byEvent[ev.id];
      var action=st
        ? '<span class="pill '+(st==='went'?'matched':'new')+'">'+(st==='went'?'you went':'you are going')+'</span>'
        : '<div class="ctas"><button type="button" class="tb-ci" data-ev="'+esc(ev.id)+'" data-st="going">I\\'m going</button>'
          +'<button type="button" class="tb-ci alt" data-ev="'+esc(ev.id)+'" data-st="went">I went</button></div>';
      var evName=ev.shortName||ev.title||'Tango event';
      var evWhen=ev.startDate?prettyDate(ev.startDate):(ev.date?prettyDate(ev.date)+(ev.time?' · '+ev.time:''):'');
      var evWhere=ev.venueName||ev.location||'';
      var evMeta=[evWhen,evWhere].filter(Boolean).join(' · ');
      return '<div class="card teacher"><h3>'+esc(evName)+'</h3>'
        +(evMeta?'<div class="studio">'+esc(evMeta)+'</div>':'')
        +action+'</div>';
    }).join(''):'<div class="card"><p class="empty">No events posted yet — check back soon.</p></div>';

    var histHtml=checkins.length
      ? '<div class="card"><h3 style="margin:0 0 10px">Your check-ins</h3>'
        +checkins.map(function(c){
          var ev=events.filter(function(e){return e.id===c.eventId;})[0];
          return '<div style="margin-bottom:4px"><span class="pill '+(c.status==='went'?'matched':'new')+'">'
            +(c.status==='went'?'went':'going')+'</span> '+(ev?esc(ev.title):'(event)')+'</div>';
        }).join('')+'</div>'
      : '';

    home.innerHTML=
      '<span class="badge">Boston Tango</span>'
      +'<h1>Welcome back, <span class="accent">'+esc(n.name||'friend')+'</span></h1>'
      +'<p class="lede">Here is what is happening near you. Tap to check in — your phone already knows it is you.</p>'
      +'<div class="card" style="text-align:center;padding:16px">'+shareBtnHtml()+'</div>'
      +evHtml
      +histHtml
      +'<div class="quiet"><a href="/lessons">Ready for lessons? Find a studio</a>'
      +'<a href="/chat?id='+encodeURIComponent(n.id||'')+'&as=newbie">Your buddy chat</a>'
      +'<a href="/social">The Rolling Newbies feed</a></div>'
      +'<p class="foot"><a href="#" id="tb-reset">Not you? Start over</a></p>';

    Array.prototype.forEach.call(home.querySelectorAll('.tb-ci'),function(btn){
      btn.addEventListener('click',function(){
        var token=getToken(); if(!token) return;
        var b=new URLSearchParams();
        b.set('token',token); b.set('eventId',btn.getAttribute('data-ev')); b.set('status',btn.getAttribute('data-st'));
        fetch('/api/checkin',{method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},
          body:b.toString()}).then(function(){loadHome(token);}).catch(function(){});
      });
    });
    var reset=document.getElementById('tb-reset');
    if(reset)reset.addEventListener('click',function(e){e.preventDefault();clearToken();location.href='/';});
    wireShare();
  }

  // V1.2.0 (F2d): "/" no longer routes strangers anywhere. renderHome() above is
  // retained and still unused; D3 will resurrect it inside /welcome's known state.
  function routeReturning(token){
    fetch('/api/me?token='+encodeURIComponent(token),{headers:{'Accept':'application/json'}})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){
        // Stale or unknown token -> drop it and just show the mission copy already
        // on this page. No redirect: a stranger belongs here.
        if(!d||!d.newbie){clearToken();return;}
        location.replace('/welcome');
      })
      // Network failure: do NOT clear the token (they may simply be offline) and
      // do not redirect — the page they are on is already the right fallback.
      .catch(function(){});
  }

  var tok=getToken();
  if(!tok) return;          // stranger: the mission copy is already rendered
  routeReturning(tok);
})();
</script>`;
}

/* ---------- gate: buddy passphrase (GET /volunteer) ------------------------- */
/* V1.1.0 (D5). Mirrors adminGatePage, but posts back to /volunteer and sets the
 * SEPARATE tb_buddy cookie. Wording is deliberately warm rather than official:
 * the person on the other side of this screen was invited by Toby and is doing
 * him a favour, so it should not read like a login wall. */

function buddyGatePage(wrong) {
  const msg = wrong
    ? '<p class="promise"><b>That passphrase did not match.</b> Try again, or ask Toby for it.</p>' : '';
  return page('Be a Tango Buddy — Boston', `
    <span class="badge">Boston Tango · Be a Buddy</span>
    <h1>Come on <span class="accent">in.</span></h1>
    <p class="lede">This page is invitation-only. Pop in the passphrase you were given
      and we will tell you what being a buddy actually involves.</p>
    ${msg}
    <div class="card">
      <form method="GET" action="/volunteer">
        <label class="fld" for="pass">Passphrase</label>
        <input id="pass" name="pass" type="password" autocomplete="current-password"
          placeholder="The phrase you were sent" required />
        <button class="submit" type="submit">Continue</button>
      </form>
    </div>
    <p class="foot">Tango Buddy · Boston · buddies are invited, not recruited.</p>
  `);
}

/* ---------- page: volunteer capture (GET /volunteer) ------------------------ */
/* V1.1.0 (D5a) — THE COPY IS THE FEATURE. People decline for three reasons:
 * they think they must dance with the newcomer, teach them, or commit
 * open-endedly. All three are killed above the fold, before the form. Tone is
 * warm, plain and unheroic: this is not a give-back appeal, it is a reassurance
 * that the job is smaller than they fear. Do not "tighten" this into bullet
 * points — the paragraphs are doing the reassuring. */

function volunteerPage(flash) {
  const thanks = flash === 'thanks'
    ? `<div class="card" style="text-align:center">
         <div class="big">🌹</div>
         <h1>Thank you, buddy!</h1>
         <p class="lede" style="margin-bottom:0">You're on the list. We'll pair you with a newcomer
         soon and make the intro. Gracias for helping someone find tango.</p>
       </div>`
    : flashNotice(flash);   // D7 validation message, see signupPage
  return page('Be a Tango Buddy — Boston', `
    <span class="badge">Boston Tango · Be a Buddy</span>
    <h1>You already know more <span class="accent">than you think.</span></h1>
    <p class="lede">Someone walked into their first milonga last week and understood none of it.
      You did too, once. Being a buddy just means they have someone to ask.</p>
    ${thanks}
    <p class="promise"><b>The short version:</b> you are not teaching, you are not dancing
      with them, and you can stop whenever you like.</p>
    <div class="card">
      <h3 style="margin:0 0 10px">What it actually is</h3>
      <p style="margin:0 0 14px">A familiar face for someone's first few months in Boston tango.
        The person they can ask the questions they are embarrassed to ask: is this milonga
        alright for a beginner, why did that person nod at me, what do I wear, when is it
        rude to leave.</p>

      <h3 style="margin:0 0 10px">You are not their teacher</h3>
      <p style="margin:0 0 14px">And you are not expected to be. That pressure is off.
        If they ask you something and you can genuinely help, then help. Do not police
        yourself. Just do not take over the teaching: point them toward the teachers and
        the places that suit <b>them</b>, the corner of the scene they take to, rather than
        the one you would have picked.</p>

      <h3 style="margin:0 0 10px">You are not their dance partner</h3>
      <p style="margin:0 0 14px">You never have to dance with them. Not once.</p>

      <h3 style="margin:0 0 10px">You never have to go anywhere with them</h3>
      <p style="margin:0 0 14px">There is no obligation to turn up to anything together, or to
        be at any particular milonga on any particular night.</p>

      <h3 style="margin:0 0 10px">What you are is a guide to the system</h3>
      <p style="margin:0 0 14px">Which milonga is kind to a newcomer on a Tuesday. What the
        codes mean. Who to say hello to. What happens when you walk through the door.
        The unwritten things nobody puts on a website.</p>

      <h3 style="margin:0 0 10px">What it costs</h3>
      <p style="margin:0 0 14px">A handful of messages a month. That is the honest number,
        not a recruiting number.</p>

      <h3 style="margin:0 0 10px">You can stop any time</h3>
      <p style="margin:0">No notice, no explanation, no guilt.</p>
    </div>
    <h2 class="tier-h" style="font-size:20px;font-weight:800;margin:22px 0 12px">
      Still interested? Tell us a little about you.</h2>
    <div class="card">
      <form method="POST" action="/api/volunteer">
        <label class="fld" for="name">Your name</label>
        <input id="name" name="name" type="text" autocomplete="name" placeholder="Your name" required />

        <label class="fld" for="contact">Best way to reach you</label>
        <input id="contact" name="contact" type="text" placeholder="Phone, email, or @handle" required />

        <label class="fld" for="area">Your Boston area / neighborhood</label>
        <input id="area" name="area" type="text" placeholder="e.g. Somerville, JP, Cambridge, Back Bay" required />

        <label class="fld" for="availability">When are you usually free?</label>
        <input id="availability" name="availability" type="text" placeholder="e.g. weeknights, Sunday practicas" />

        <label class="fld" for="note">Anything else? <span style="font-weight:500;color:#a98a76">(optional)</span></label>
        <textarea id="note" name="note" placeholder="Years dancing, lead/follow, favorite milongas…"></textarea>

        <button class="submit" type="submit">Sign me up as a buddy</button>
      </form>
    </div>
    <p class="foot">Tango Buddy · Boston · the community that keeps people dancing.</p>
  `);
}

/* ---------- page: Lessons tab / studios directory (GET /lessons) ------------ */
/* v0.8.2 — the LESSONS tab, restyled as a PRINTED DIRECTORY CARD (a "Beginner
 * Lessons" bookmark), NOT an app screen. Real Boston studios that teach beginner
 * lessons, a SEPARATE collection from organizers (which live on /events). Each
 * studio is a printed LINE: the name in bold warm terracotta (the prominent
 * element), then the contact in small "fine print" below (phone · website).
 * A hairline rule separates each entry, like a printed directory. NO BUTTONS —
 * phone stays a subtle tel: link and the website a subtle plain link so mobile
 * tap-to-call still works, but visually it reads as fine print, not controls.
 * Studios are listed ALPHABETICALLY (case-insensitive). PUBLIC — money-free. */

// Normalize a bare domain (e.g. "bluetango.org") to an https:// URL, leaving
// already-qualified links untouched.
function studioHref(web) {
  const w = String(web || '').trim();
  if (!w) return '';
  return /^https?:\/\//i.test(w) ? w : 'https://' + w;
}

// Strip the scheme (and any trailing slash) so the printed fine print reads as a
// bare domain like "bluetango.org" rather than "https://bluetango.org/".
function studioWebLabel(web) {
  return String(web || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

async function lessonsPage() {
  const studios = (await store.listStudios()).slice().sort((a, b) =>
    String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()));

  const rows = studios.length ? studios.map((s) => {
    const href = studioHref(s.web);
    // Fine print: phone (tel:) · website (plain link). Omit whichever is absent —
    // no empty dashes cluttering the line.
    const parts = [];
    if (s.phone) {
      parts.push(`<a class="dir-tel" href="tel:${esc(s.phone.replace(/[^0-9+]/g, ''))}">${esc(s.phone)}</a>`);
    }
    if (href) {
      parts.push(`<a class="dir-web" href="${esc(href)}" target="_blank" rel="noopener">${esc(studioWebLabel(s.web))}</a>`);
    }
    const fine = parts.length
      ? `<div class="dir-fine">${parts.join('<span class="dir-sep"> · </span>')}</div>`
      : '';
    return `<div class="dir-entry">
      <div class="dir-name">${esc(s.name)}</div>
      ${fine}
    </div>`;
  }).join('') : `<p class="empty">No studios listed yet — check back soon.</p>`;

  return page('Boston Tango Lessons', `
    <span class="badge">Boston Tango · Lessons</span>
    <h1>Beginner lessons <span class="accent">in Boston</span></h1>
    <p class="lede">A little card of the studios that welcome first-timers. Keep it in your
      pocket — your buddy can come along and help you take the first step.</p>
    <div class="dir-card">
      ${rows}
    </div>
    <p class="foot">Tango Buddy · Boston · the studios that welcome first-timers.</p>
    <style>
      /* Printed lessons card / bookmark — editorial, not app chrome. */
      .dir-card{background:#fffaf3;border:1px solid var(--line);border-radius:16px;
        padding:6px 20px;box-shadow:0 10px 30px rgba(158,63,39,.08)}
      .dir-entry{padding:18px 0;border-bottom:1px solid var(--line)}
      .dir-entry:last-child{border-bottom:none}
      .dir-name{font-weight:800;font-size:19px;line-height:1.25;color:var(--terra);
        letter-spacing:.01em}
      .dir-fine{margin-top:5px;font-size:13px;line-height:1.5;color:#a98a76}
      .dir-fine a{color:#a98a76;text-decoration:none}
      .dir-fine a:active{color:var(--terra-d)}
      .dir-fine .dir-tel{white-space:nowrap}
      .dir-sep{color:var(--line)}
    </style>
  `, { index: true, path: '/lessons' });
}

/* ---------- page: public events listing (GET /events) ----------------------- */
/* v0.8.1 — a LIVE feed of beginner nights for the NEXT 2 WEEKS, pulled server-side
 * from the MasterCalendar/TangoTiempo API (beginnerFriendly=true SUPERSET, near
 * Boston), with recurring MASTERS expanded (RRULE) into real dated occurrences.
 * ONE fetch, split by flag into THREE tiers: (1) "For beginners" forBeginners,
 * (2) "Feeling a bit more adventurous?" beginnerFriendly-not-forBeginners,
 * (3) "Even more" → tangotiempo.com / ask your buddy. Empty tiers are hidden.
 * Falls back to the stored seed events when the live feed is empty / unreachable,
 * so the page never goes blank. NO LOGIN. Each card whole-links to tangotiempo.*/

function typePill(type) {
  const cls = { Milonga: 'matched', Practica: 'new', Class: 'yes', Social: 'no' }[type] || 'new';
  return `<span class="pill ${cls}">${esc(type)}</span>`;
}

// Friendly date like "Fri, Jul 3" (falls back to raw string if unparseable).
function prettyDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (e) { return dateStr; }
}

// Friendly date + time for an ISO string (TangoTiempo `startDate`), e.g.
// "Thu, Jul 9 · 7:00 PM". Falls back to the raw string if unparseable.
function prettyDateTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) { return iso; }
}

// One mobile-first event card. Shared by the LIVE feed (normalized occurrences
// carry `date`) and the stored fallback (seed events carry `startDate`). Each
// card is ONE tap-target that deep-links to its tangotiempo.com/event/<id> page.
//   [icon]  shortName (bold)
//           org name
//           date/day · category pill · venue
function eventCardHtml(ev) {
  const href = ev.url || ev.link || 'https://tangotiempo.com';
  const label = ev.shortName || ev.title || 'Tango event';
  // Icon is external (Azure blob) — reference directly; hide gracefully when
  // absent or if the URL 404s.
  const thumb = ev.image
    ? `<img class="ev-thumb" src="${esc(ev.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
    : '';
  const orgLine = ev.orgName ? `<div class="ev-org">${esc(ev.orgName)}</div>` : '';
  // Live occurrences carry an ISO `date`; seed events carry `startDate` (or the
  // legacy `date`+`time`). Prefer whichever is present.
  const whenSrc = ev.date || ev.startDate;
  const when = whenSrc
    ? (String(whenSrc).indexOf('T') > -1
      ? prettyDateTime(whenSrc)
      : prettyDate(whenSrc) + (ev.time ? ' · ' + ev.time : ''))
    : '';
  const cat = ev.category || ev.type;
  const venue = ev.venueName || ev.location;
  const meta = `<div class="ev-meta">
      ${when ? `<span>${esc(when)}</span>` : ''}
      ${cat ? typePill(cat) : ''}
      ${venue ? `<span>${esc(venue)}</span>` : ''}
    </div>`;
  return `<a class="card ev-card" href="${esc(href)}" target="_blank" rel="noopener">
    ${thumb}
    <div class="ev-body">
      <div class="ev-name">${esc(label)}</div>
      ${orgLine}
      ${meta}
    </div>
  </a>`;
}

async function eventsPage(flash) {
  // LIVE FEED FIRST: pull the next-2-weeks beginnerFriendly SUPERSET from the
  // MasterCalendar API (server-side, cached, RRULE-expanded). One fetch, then
  // SPLIT BY FLAG into two tiers. If it comes back empty or not-live, fall back
  // to the stored seed events (the current 4) so the page never blanks.
  const live = await getLiveEvents();
  let usingFallback = false;
  const feed = (live && live.live && live.events.length) ? live.events : null;

  // Tier 1: made-for-newcomers.  Tier 2: broader beginner-friendly set MINUS
  // tier 1 (still welcoming, a bit more going on).
  let tier1 = [];
  let tier2 = [];
  let fallbackItems = null;
  if (feed) {
    tier1 = feed.filter((ev) => ev.forBeginners === true);
    tier2 = feed.filter((ev) => ev.beginnerFriendly === true && ev.forBeginners !== true);
  }
  // Fall back to seed when the live feed produced NOTHING usable in either tier.
  if (!tier1.length && !tier2.length) {
    usingFallback = true;
    // Manual-curation-wins: seed events are hand-picked beginner links, so a
    // missing/unknown flag defaults to TRUE — only hide an EXPLICITLY-false one.
    fallbackItems = (await store.listEvents()).filter((ev) => ev.beginnerFriendly !== false);
  }

  const thanks = flash === 'checkedin'
    ? `<p class="promise"><b>Got it — see you on the dance floor!</b> Your check-in is saved.
        Your buddy and the community can see where you are dancing.</p>` : '';

  // Build the tier body. On fallback: a single "Beginner-friendly events" section with the
  // saved-picks note (0.8.0 behavior). Live: hide any empty tier's heading.
  let tiersHtml;
  if (usingFallback) {
    const cards = fallbackItems.length
      ? fallbackItems.map(eventCardHtml).join('')
      : `<div class="card"><p class="empty">No beginner-friendly events in the next 2 weeks — check back soon.</p></div>`;
    tiersHtml = `
      <p class="hint" style="margin:0 0 14px">showing saved picks</p>
      <h2 class="tier-h">Beginner-friendly events</h2>
      ${cards}`;
  } else {
    const tier1Html = tier1.length ? `
      <h2 class="tier-h">For beginners</h2>
      <p class="tier-sub">Made for newcomers — come as you are.</p>
      ${tier1.map(eventCardHtml).join('')}` : '';
    const tier2Html = tier2.length ? `
      <h2 class="tier-h">Feeling a bit more adventurous?</h2>
      <p class="tier-sub">Still welcoming, a little more going on.</p>
      ${tier2.map(eventCardHtml).join('')}` : '';
    tiersHtml = tier1Html + tier2Html;
  }

  // Tier 3 — "Even more": money-free hand-off to the whole Boston calendar + the buddy.
  const moreBlock = `
    <div class="card teacher">
      <h3>Even more</h3>
      <p>Want the full Boston calendar? →
        <a href="https://tangotiempo.com" target="_blank" rel="noopener"><b>tangotiempo.com</b></a><br>
        Or, anytime, <b style="color:var(--terra-d)">ask your buddy.</b></p>
      <div class="ctas">
        <a href="https://tangotiempo.com" target="_blank" rel="noopener">Open the whole calendar →</a>
      </div>
    </div>`;

  return page('Boston Tango Events', `
    <div id="tb-hello" hidden></div>
    <span class="badge">Boston Tango · Events</span>
    <h1>Beginner-friendly events — <span class="accent">next 2 weeks</span></h1>
    <p class="lede">Events made for newcomers, near Boston. Come as you are.</p>
    ${heroBlock()}
    ${thanks}
    ${helloBannerScript()}
    ${tiersHtml}
    ${moreBlock}
    <p class="foot">Tango Buddy · Boston · come dance — the whole city is your milonga.</p>
    <style>
      .ev-card{display:flex;gap:12px;align-items:center;text-decoration:none;color:var(--ink)}
      .ev-card:active{background:#fff8f2}
      .ev-thumb{width:64px;height:64px;border-radius:12px;object-fit:cover;flex:0 0 auto;
        border:1px solid var(--line);background:#fff2e8}
      .ev-body{flex:1;min-width:0}
      .ev-name{font-weight:800;font-size:17px;line-height:1.2;margin-bottom:2px}
      .ev-org{color:var(--terra-d);font-weight:700;font-size:14px;margin-bottom:7px}
      .ev-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--soft)}
      .tier-h{font-size:20px;font-weight:800;margin:22px 0 2px}
      .tier-h:first-of-type{margin-top:6px}
      .tier-sub{color:var(--soft);font-size:14px;margin:0 0 12px}
    </style>
  `, { index: true, path: '/events' });
}

/* V1.0.0 (C4) — the "Hello, {FirstName}" banner on /events.
 *
 * Rendered CLIENT-side because the identity lives in localStorage.tb_token, and
 * /events is a cacheable public page — the HTML must stay identical for everyone.
 * A stranger with no token sees nothing at all (the div stays `hidden`).
 *
 * SECURITY: newbie.name is user-supplied and goes into the DOM, so it is written
 * with textContent, never innerHTML — an attacker-chosen name like
 * `<script>alert(1)</script>` renders as literal text and cannot execute. */
function helloBannerScript() {
  return `<script>
(function(){
  var LSK='tb_token';
  var el=document.getElementById('tb-hello'); if(!el) return;
  var tok; try{tok=localStorage.getItem(LSK);}catch(e){return;}
  if(!tok) return;
  fetch('/api/me?token='+encodeURIComponent(tok),{headers:{'Accept':'application/json'}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      // Unknown/expired token: drop it. No redirect — /events is public and a
      // visitor reading it should never be bounced away mid-read.
      if(!d||!d.newbie){try{localStorage.removeItem(LSK);}catch(e){} return;}
      var name=String(d.newbie.name==null?'':d.newbie.name).trim();
      var first=name?name.split(/\\s+/)[0]:'';
      var h=document.createElement('p');
      h.className='promise';
      var b=document.createElement('b');
      // Blank/missing name -> a plain greeting, never a dangling "Hello, ".
      b.textContent = first ? ('Hello, '+first+'!') : 'Welcome back!';
      h.appendChild(b);
      h.appendChild(document.createTextNode(' Good to see you again — here is what is on.'));
      el.appendChild(h);
      el.hidden=false;
    })
    .catch(function(){});
})();
</script>`;
}

/* ---------- page: admin dashboard (GET /admin) ------------------------------ */
/* NOTE: no auth — LOCAL DEMO ONLY. In production, gate this route behind an
 * operator login / session check RIGHT HERE (e.g. verify a signed cookie or an
 * auth header) before rendering anything below. */

async function adminPage(flash) {
  const newbies = await store.listNewbies();
  const volunteers = await store.listVolunteers();
  const volById = Object.fromEntries(volunteers.map((v) => [v.id, v]));

  const organizers = await store.listTeachers();   // organizers == teachers inventory
  const orgById = Object.fromEntries(organizers.map((t) => [t.id, t]));
  const events = await store.listEvents();

  // Prefetch each newbie's check-ins up front (can't await inside .map below).
  const checkinsByNewbie = {};
  await Promise.all(newbies.map(async (n) => {
    checkinsByNewbie[n.id] = await store.listCheckinsForNewbie(n.id);
  }));

  const volOptions = volunteers.map((v) =>
    `<option value="${esc(v.id)}">${esc(v.name)} — ${esc(v.area)}</option>`).join('');
  const orgOptions = organizers.map((t) =>
    `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.studio)}</option>`).join('');

  const newbieRows = newbies.length ? newbies.map((n) => {
    const buddy = n.buddyId ? volById[n.buddyId] : null;
    const buddyLabel = buddy ? esc(buddy.name) : '<span class="empty" style="padding:0">—</span>';
    const statusPill = n.status === 'matched'
      ? '<span class="pill matched">matched</span>'
      : '<span class="pill new">new</span>';
    const consentPill = n.consent
      ? '<span class="pill yes">yes</span>' : '<span class="pill no">no</span>';
    // D1a: wantsBuddy is a TRI-STATE and must be rendered as one.
    //   true      -> they asked for a buddy
    //   false     -> they explicitly declined. An explicit no is a real refusal.
    //   undefined -> NOBODY EVER ASKED. This is the case for all seven backfilled
    //                historical newcomers. Rendering that as "no" would be a
    //                factual claim about a real person that Toby might act on.
    const wantsBuddy = n.wantsBuddy;
    const askedForBuddy = wantsBuddy === true;
    const declinedBuddy = wantsBuddy === false;
    const neverAsked = !askedForBuddy && !declinedBuddy;
    const wantsBuddyPill = askedForBuddy
      ? '<span class="pill yes">wants a buddy</span>'
      : declinedBuddy
        ? '<span class="pill no">no buddy, thanks</span>'
        : '<span class="pill new" title="This person signed up before we asked. '
          + 'It is not a no.">never asked</span>';

    // Dance history — also tri-state, same rule. "not asked" must never render as
    // "no": someone who has salsa-d for ten years needs a completely different
    // welcome from someone who has never danced, and a wrong "no" here sends the
    // wrong one. The seven historical rows DO carry these answers from the old
    // Formspree form, so this is recovered continuity, not a new question.
    const triLabel = (v, yes, no) => (v === true ? yes : v === false ? no : null);
    const danceBits = [
      triLabel(n.dancedTangoBefore, 'danced tango', 'new to tango'),
      triLabel(n.dancedBefore, n.dancedWhat ? `danced: ${n.dancedWhat}` : 'danced before',
        'never danced'),
    ].filter(Boolean);
    const danceLabel = danceBits.length
      ? `<div class="hint" style="margin-top:4px">${esc(danceBits.join(' · '))}</div>`
      : '';

    // Per-newbie match control -> POST /api/match.
    // Hidden ONLY for an explicit decline. Shown-but-badged for "never asked":
    // the seven real newcomers all predate the question, so hiding it for
    // anything short of an explicit yes would make matching impossible for every
    // real person in the system and the product could never run. Badging keeps
    // the operator honest about which he is relying on — an inference, not
    // consent. Flagged to Edison in PHASE-D-STATUS.md.
    const matchControl = declinedBuddy
      ? '<span class="empty" style="padding:0" title="They declined a buddy at signup.">'
        + 'declined — not matchable</span>'
      : !volunteers.length
        ? '<span class="empty" style="padding:0">no volunteers yet</span>'
        : `
      <form class="match-form" method="POST" action="/api/match">
        <input type="hidden" name="newbieId" value="${esc(n.id)}" />
        <select name="volunteerId">
          <option value="">— assign buddy —</option>
          ${volOptions}
        </select>
        <button type="submit">Assign</button>
      </form>${neverAsked
        ? '<div class="hint" style="margin-top:4px">never asked — check before pairing</div>'
        : ''}`;
    // V1.1: check-in history (the retention signal — "where they go").
    const checkins = checkinsByNewbie[n.id] || [];
    const evById = Object.fromEntries(events.map((e) => [e.id, e]));
    const checkinLabel = checkins.length ? checkins.map((c) => {
      const ev = evById[c.eventId];
      const label = ev ? esc(ev.title) : '(event removed)';
      return `<div style="margin-bottom:3px">${c.status === 'went'
        ? '<span class="pill matched">went</span>' : '<span class="pill new">going</span>'}
        ${label}</div>`;
    }).join('') : '<span class="empty" style="padding:0">—</span>';

    // V1.1: ready-for-lessons toggle + handover to an organizer.
    const readyPill = n.readyForLessons
      ? '<span class="pill yes">ready</span>' : '<span class="pill no">not yet</span>';
    const readyForm = `
      <form class="match-form" method="POST" action="/api/ready" style="margin-bottom:6px">
        <input type="hidden" name="newbieId" value="${esc(n.id)}" />
        <input type="hidden" name="ready" value="${n.readyForLessons ? '' : 'on'}" />
        <button type="submit">${n.readyForLessons ? 'Unmark ready' : 'Mark ready'}</button>
      </form>`;
    const handedTo = n.handedToOrganizerId && orgById[n.handedToOrganizerId];
    const handoverControl = handedTo
      ? `<div><span class="pill matched">Handed to ${esc(handedTo.name)}</span></div>`
      : (organizers.length ? `
        <form class="match-form" method="POST" action="/api/handover">
          <input type="hidden" name="newbieId" value="${esc(n.id)}" />
          <select name="organizerId">
            <option value="">— hand to organizer —</option>
            ${orgOptions}
          </select>
          <button type="submit">Hand off</button>
        </form>` : '<span class="empty" style="padding:0">no organizers</span>');

    return `<tr>
      <td><b>${esc(n.name) || '(no name)'}</b></td>
      <td>${esc(n.contact)}</td>
      <td>${esc(n.platform)}</td>
      <td>${esc(n.origination) || '<span class="empty" style="padding:0">—</span>'}</td>
      <td>${wantsBuddyPill}${danceLabel}</td>
      <td>${consentPill}</td>
      <td>${statusPill}</td>
      <td>${buddyLabel}</td>
      <td>${matchControl}</td>
      <td>${checkinLabel}</td>
      <td>${readyPill}${readyForm}${handoverControl}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="11" class="empty">No newbies captured yet. Try the
      <a href="/signup">sign-up page</a>.</td></tr>`;

  const volRows = volunteers.length ? volunteers.map((v) => {
    const matched = newbies.filter((n) => n.buddyId === v.id).length;
    return `<tr>
      <td><b>${esc(v.name)}</b></td>
      <td>${esc(v.contact)}</td>
      <td>${esc(v.area)}</td>
      <td>${esc(v.availability) || '—'}</td>
      <td>${matched ? matched + ' newbie' + (matched > 1 ? 's' : '') : '—'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty">No volunteers yet. Send buddies to the
      <a href="/volunteer">volunteer page</a> (we need ~10).</td></tr>`;

  // V1.1: events + organizers management ---------------------------------------
  const TYPES = ['Milonga', 'Practica', 'Class', 'Social'];
  const typeOpts = (sel) => TYPES.map((t) =>
    `<option value="${t}"${t === sel ? ' selected' : ''}>${t}</option>`).join('');
  const orgSelect = (name, sel) => `<select name="${name}"><option value="">— none —</option>${
    organizers.map((t) => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.name)}</option>`).join('')
  }</select>`;

  const eventRows = events.length ? events.map((ev) => {
    const thumb = ev.image
      ? `<img src="${esc(ev.image)}" alt="" style="width:40px;height:40px;border-radius:8px;object-fit:cover;border:1px solid var(--line)" onerror="this.style.display='none'" />`
      : '';
    // "Refresh from TangoTiempo" — re-pull the stored fields for a TT-sourced event.
    const refresh = ev.ttId
      ? `<form class="match-form" method="POST" action="/api/event/refresh" style="margin-top:4px">
           <input type="hidden" name="eventId" value="${esc(ev.id)}" />
           <button type="submit">↻ Refresh from TangoTiempo</button>
         </form>`
      : '';
    return `<tr>
      <td style="width:52px">${thumb}</td>
      <td><form class="match-form" method="POST" action="/api/event/update" style="flex-wrap:wrap;gap:4px">
        <input type="hidden" name="eventId" value="${esc(ev.id)}" />
        <input type="text" name="shortName" value="${esc(ev.shortName || ev.title)}" placeholder="Short name" style="min-width:150px" />
        <input type="text" name="orgName" value="${esc(ev.orgName)}" placeholder="Organizer" style="min-width:130px" />
        <select name="type">${typeOpts(ev.category || ev.type)}</select>
        <input type="text" name="startDate" value="${esc(ev.startDate)}" placeholder="ISO date" style="min-width:150px" />
        <input type="text" name="venueName" value="${esc(ev.venueName || ev.location)}" placeholder="Venue" style="min-width:130px" />
        <input type="text" name="url" value="${esc(ev.url || ev.link)}" placeholder="https://tangotiempo.com/event/…" style="min-width:160px" />
        <button type="submit">Save</button>
      </form>${refresh}</td>
    </tr>`;
  }).join('') : `<tr><td class="empty" colspan="2">No events yet — add one below.</td></tr>`;

  const organizerRows = organizers.length ? organizers.map((t) => `<tr>
      <td><form class="match-form" method="POST" action="/api/organizer/update" style="flex-wrap:wrap;gap:4px">
        <input type="hidden" name="orgId" value="${esc(t.id)}" />
        <input type="text" name="name" value="${esc(t.name)}" style="min-width:140px" />
        <input type="text" name="studio" value="${esc(t.studio)}" style="min-width:170px" />
        <input type="text" name="email" value="${esc(t.email)}" style="min-width:150px" />
        <input type="text" name="phone" value="${esc(t.phone)}" style="min-width:120px" />
        <button type="submit">Save</button>
      </form></td>
    </tr>`).join('') : `<tr><td class="empty">No organizers yet — add one below.</td></tr>`;

  const eventsCard = `
    <div class="card">
      <h3 style="margin:0 0 12px">Events <span class="demo-tag">manage</span></h3>
      <div class="scroll"><table><tbody>${eventRows}</tbody></table></div>
      <h3 style="margin:16px 0 4px;font-size:15px">Add event from TangoTiempo link</h3>
      <p class="hint" style="margin:0 0 10px">Paste a TangoTiempo event link
        (<code>https://tangotiempo.com/event/…</code>) or its id — we pull the short name,
        organizer, date, venue and icon automatically.</p>
      <form class="match-form" method="POST" action="/api/event/tt" style="flex-wrap:wrap;gap:6px">
        <input type="text" name="tt" placeholder="TangoTiempo link or event id" required style="min-width:240px;flex:1" />
        <button type="submit">Add from TangoTiempo</button>
      </form>
    </div>`;

  const organizersCard = `
    <div class="card">
      <h3 style="margin:0 0 4px">Organizers (events) <span class="demo-tag">manage</span></h3>
      <p class="hint" style="margin:0 0 12px">The inventory attached to <b>events</b> — who hosts
        Boston's milongas / practicas / classes. Separate from the Lessons studios below.</p>
      <div class="scroll"><table><tbody>${organizerRows}</tbody></table></div>
      <h3 style="margin:16px 0 8px;font-size:15px">Add an organizer</h3>
      <form class="match-form" method="POST" action="/api/organizer" style="flex-wrap:wrap;gap:6px">
        <input type="text" name="name" placeholder="Name" required style="min-width:150px" />
        <input type="text" name="studio" placeholder="Studio / venue" required style="min-width:170px" />
        <input type="text" name="email" placeholder="Email (optional)" style="min-width:150px" />
        <input type="text" name="phone" placeholder="Phone (optional)" style="min-width:130px" />
        <button type="submit">Add organizer</button>
      </form>
    </div>`;

  // Studios / Teachers = the LESSONS tab (a SEPARATE collection from organizers).
  const studios = await store.listStudios();
  const studioRows = studios.length ? studios.map((s) => `<tr>
      <td><form class="match-form" method="POST" action="/api/studio/update" style="flex-wrap:wrap;gap:4px">
        <input type="hidden" name="studioId" value="${esc(s.id)}" />
        <input type="text" name="name" value="${esc(s.name)}" style="min-width:150px" />
        <input type="text" name="phone" value="${esc(s.phone)}" placeholder="Phone" style="min-width:130px" />
        <input type="text" name="web" value="${esc(s.web)}" placeholder="Website" style="min-width:160px" />
        <button type="submit">Save</button>
      </form></td>
    </tr>`).join('') : `<tr><td class="empty">No studios yet — add one below.</td></tr>`;

  const studiosCard = `
    <div class="card">
      <h3 style="margin:0 0 4px">Studios / Teachers (lessons) <span class="demo-tag">manage</span></h3>
      <p class="hint" style="margin:0 0 12px">The Boston studios shown on the <b>Lessons</b> tab
        (<a href="/lessons">/lessons</a>) — with Call &amp; Website CTAs. Separate from the
        event Organizers above.</p>
      <div class="scroll"><table><tbody>${studioRows}</tbody></table></div>
      <h3 style="margin:16px 0 8px;font-size:15px">Add a studio</h3>
      <form class="match-form" method="POST" action="/api/studio" style="flex-wrap:wrap;gap:6px">
        <input type="text" name="name" placeholder="Studio / teacher" required style="min-width:150px" />
        <input type="text" name="phone" placeholder="Phone (optional)" style="min-width:130px" />
        <input type="text" name="web" placeholder="Website (optional)" style="min-width:160px" />
        <button type="submit">Add studio</button>
      </form>
    </div>`;

  // Current pairings summary
  const pairs = newbies.filter((n) => n.buddyId && volById[n.buddyId]);
  const pairRows = pairs.length ? pairs.map((n) =>
    `<tr><td><b>${esc(n.name)}</b></td><td>↔</td><td><b>${esc(volById[n.buddyId].name)}</b></td>
     <td>${esc(volById[n.buddyId].area)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">No pairings yet — assign a buddy above.</td></tr>`;

  const flashBanner = flash === 'ttfail'
    ? `<p class="promise"><b>Couldn't fetch that TangoTiempo event.</b> Check the link or id and try again.</p>`
    : flash === 'ttadded'
      ? `<p class="promise"><b>Event added from TangoTiempo.</b> It is live on <a href="/events">/events</a>.</p>`
      : flash === 'ttrefreshed'
        ? `<p class="promise"><b>Refreshed from TangoTiempo.</b> Latest details pulled.</p>` : '';

  return page('Tango Buddy — Admin', `
    <span class="badge">Operator Dashboard</span>
    <h1>Tango Buddy <span class="accent">admin</span></h1>
    <p class="lede">${newbies.length} newbie(s) · ${volunteers.length} volunteer(s) · ${pairs.length} pairing(s).
      Local demo — no login.</p>
    ${flashBanner}

    <div class="card">
      <h3 style="margin:0 0 12px">Newbies</h3>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th>Contact</th><th>Platform</th><th>Found us</th><th>Buddy?</th><th>Consent</th>
          <th>Status</th><th>Buddy</th><th>Match</th><th>Check-ins</th><th>Lessons handover</th></tr></thead>
        <tbody>${newbieRows}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 12px">Volunteers (buddies)</h3>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th>Contact</th><th>Area</th><th>Availability</th><th>Assigned</th></tr></thead>
        <tbody>${volRows}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 12px">Current pairings</h3>
      <div class="scroll"><table>
        <thead><tr><th>Newbie</th><th></th><th>Buddy</th><th>Area</th></tr></thead>
        <tbody>${pairRows}</tbody>
      </table></div>
    </div>

    ${eventsCard}
    ${organizersCard}
    ${studiosCard}
    <p class="foot">Tango Buddy · Boston · operator view.</p>
  `, { wide: true });
}

/* ---------- page: Buddy <-> Newbie chat (GET /chat) ------------------------- */
/* NO LOGIN. A demo "view as" selector picks a matched pairing and which side
 * (newbie or buddy) you're speaking as. Messages persist via store.js; a tiny
 * client poller hits GET /api/thread every ~3s so it feels live. */

async function chatPage(params) {
  const newbies = await store.listNewbies();
  const volunteers = await store.listVolunteers();
  const volById = Object.fromEntries(volunteers.map((v) => [v.id, v]));
  // A "pairing" = a matched newbie whose buddy volunteer still exists.
  const pairs = newbies.filter((n) => n.buddyId && volById[n.buddyId]);

  if (!pairs.length) {
    return page('Tango Buddy — Chat', `
      <span class="badge">Buddy · Newbie chat</span>
      <h1>No <span class="accent">pairings</span> yet</h1>
      <p class="lede">Buddy chat opens once a newbie is matched with a buddy.</p>
      <div class="card" style="text-align:center">
        <div class="big">💬</div>
        <p class="lede" style="margin-bottom:0">Head to the <a href="/admin">Admin</a> page and
        assign a buddy to a newbie first — then come back here to chat as either side.</p>
      </div>
      <p class="foot">Tango Buddy · Boston · private buddy ↔ newbie thread.</p>
    `);
  }

  // Which pairing + which side are we viewing as?
  let sel = pairs.find((n) => n.id === params.id) || pairs[0];
  const side = params.as === 'buddy' ? 'buddy' : 'newbie';
  const buddy = volById[sel.buddyId];
  const thread = await store.getOrCreateBuddyThread(sel.id);
  const meName = side === 'buddy' ? buddy.name : sel.name;
  const otherName = side === 'buddy' ? sel.name : buddy.name;

  const pairOptions = pairs.map((n) =>
    `<option value="${esc(n.id)}"${n.id === sel.id ? ' selected' : ''}>${esc(n.name)} ↔ ${esc(volById[n.buddyId].name)}</option>`
  ).join('');

  const seg = (val, label) => {
    const q = `/chat?id=${encodeURIComponent(sel.id)}&as=${val}`;
    return `<a href="${esc(q)}" class="${side === val ? 'on' : ''}">${esc(label)}</a>`;
  };

  return page('Tango Buddy — Chat', `
    <span class="badge">Buddy · Newbie chat <span class="demo-tag">no login · view as</span></span>
    <h1>Chat with your <span class="accent">${esc(otherName)}</span></h1>
    <p class="lede">Private 1:1 thread. Pick a pairing and choose whose side to speak from — this is a
      demo, so no login: you can be either person.</p>

    <div class="card">
      <form class="switcher" method="GET" action="/chat">
        <div>
          <label class="fld" style="margin-top:0">Pairing</label>
          <select name="id" onchange="this.form.submit()">${pairOptions}</select>
        </div>
        <div>
          <label class="fld" style="margin-top:0">You are…</label>
          <div class="seg">${seg('newbie', sel.name + ' (newbie)')}${seg('buddy', buddy.name + ' (buddy)')}</div>
        </div>
        <noscript><button class="submit" style="width:auto;margin-top:0;padding:12px 16px">Go</button></noscript>
      </form>
    </div>

    <div class="card">
      <ul id="thread" class="thread"><li class="empty">Loading…</li></ul>
      <form id="composer" class="composer" method="POST" action="/api/chat">
        <input type="hidden" name="threadId" value="${esc(thread.id)}" />
        <input type="hidden" name="fromName" value="${esc(meName)}" />
        <input type="hidden" name="redirect" value="/chat?id=${esc(sel.id)}&as=${side}" />
        <input type="text" name="body" placeholder="Message as ${esc(meName)}…" autocomplete="off" required />
        <button type="submit">Send</button>
      </form>
    </div>
    <p class="foot">Tango Buddy · Boston · speaking as <b>${esc(meName)}</b> · updates live.</p>

    ${threadScript(thread.id, meName)}
  `);
}

/* ---------- page: Rolling Newbies social feed (GET /social) ----------------- */
/* One open group feed shared by the whole newbie cohort. No login: pick a name
 * (or free-type one) and post. Same ~3s poll. */

async function socialPage() {
  const thread = await store.getRollingNewbiesThread();
  const newbies = await store.listNewbies();
  const nameOptions = newbies.map((n) =>
    `<option value="${esc(n.name)}">${esc(n.name)}</option>`).join('');

  return page('Tango Buddy — Social', `
    <span class="badge">Rolling Newbies <span class="demo-tag">the cohort</span></span>
    <h1>The <span class="accent">Rolling Newbies</span></h1>
    <p class="lede">One open feed everyone learning tango shares. Say hi, ask a question, find people
      to go to a milonga with. This is the "social" in buddy + social.</p>

    <div class="card">
      <ul id="thread" class="thread"><li class="empty">Loading…</li></ul>
      <form id="composer" class="composer" method="POST" action="/api/social" style="flex-wrap:wrap">
        <input type="hidden" name="threadId" value="${esc(thread.id)}" />
        <input type="hidden" name="redirect" value="/social" />
        <input type="text" name="fromName" list="newbie-names" placeholder="Posting as…"
          autocomplete="off" style="flex:0 0 34%;min-width:130px" required />
        <datalist id="newbie-names">${nameOptions}</datalist>
        <input type="text" name="body" placeholder="Say something to the cohort…" autocomplete="off" required />
        <button type="submit">Post</button>
      </form>
    </div>
    <p class="foot">Tango Buddy · Boston · the peer cohort · updates live.</p>

    ${threadScript(thread.id, ' ')}
  `);
}

/* Shared client poller: fetch messages every 3s and render them. meName marks
 * "your" bubbles; pass " " (never a real name) for feeds with no fixed you. */
function threadScript(threadId, meName) {
  return `<script>
(function(){
  var THREAD=${JSON.stringify(threadId)}, ME=${JSON.stringify(meName)};
  var box=document.getElementById('thread');
  var form=document.getElementById('composer');
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function when(iso){try{return new Date(iso).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});}catch(e){return '';}}
  var lastCount=-1;
  function render(msgs){
    if(msgs.length===lastCount) return; lastCount=msgs.length;
    if(!msgs.length){box.innerHTML='<li class="empty">No messages yet — say hello!</li>';return;}
    box.innerHTML=msgs.map(function(m){
      var mine=(m.fromName===ME)?' me':'';
      return '<li class="msg'+mine+'"><span class="who">'+esc(m.fromName)+'</span>'+
        esc(m.body)+'<span class="when">'+when(m.createdAt)+'</span></li>';
    }).join('');
    box.scrollTop=box.scrollHeight;
  }
  function poll(){
    fetch('/api/thread?id='+encodeURIComponent(THREAD)).then(function(r){return r.json();})
      .then(function(d){render(d.messages||[]);}).catch(function(){});
  }
  if(form){form.addEventListener('submit',function(ev){
    ev.preventDefault();
    var fd=new FormData(form);
    var input=form.querySelector('input[name=body]');
    fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams(fd).toString()})
      .then(function(){input.value='';lastCount=-1;poll();}).catch(function(){});
  });}
  poll(); setInterval(poll, 3000);
})();
</script>`;
}

/* ---------- page: "What's Coming" preview (GET /coming) --------------------- */
/* CRITICAL: features & ideas ONLY. No money / pricing / payments / revenue —
 * describe each card as an EXPERIENCE, never its economics. */

function comingPage() {
  const cards = [
    { ico: '🪪', title: 'The Buddy Card',
      body: 'One card, tango across the city. A little identity that travels with you from your first lesson to your hundredth milonga — carry your tango life in one place.',
      tease: 'On the drawing board' },
    { ico: '📅', title: 'Events',
      body: 'Milongas, practicas and classes gathered in one warm calendar. See what is on tonight, who is going, and never miss the dance around the corner.',
      tease: 'Coming soon' },
    { ico: '✅', title: 'Check-in',
      body: 'Track your tango journey. Mark the nights you danced, the milestones you hit, and look back on how far you have come since that nervous first step.',
      tease: 'Coming soon' },
    { ico: '🎓', title: 'Studio handover',
      body: 'When you are ready for real lessons, a gentle handover to a welcoming teacher or studio — your buddy can come along, and nothing feels like a cold start.',
      tease: 'On the roadmap' },
    { ico: '💬', title: 'Community chat',
      body: 'Organizers and newcomers in the same friendly room. Ask the local hosts anything, get the inside scoop, and feel part of the scene before you even arrive.',
      tease: 'On the roadmap' },
  ];
  const html = cards.map((c) => `
    <div class="soon">
      <div class="ico">${c.ico}</div>
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.body)}</p>
      <span class="tease">${esc(c.tease)}</span>
    </div>`).join('');

  return page('Tango Buddy — What\'s Coming', `
    <span class="badge">What's Coming</span>
    <h1>Where <span class="accent">Tango Buddy</span> is headed</h1>
    <p class="lede">Buddy chat and the Rolling Newbies feed are just the start. Here is a peek at the
      experiences we are dreaming up next — all about keeping you dancing.</p>
    ${heroBlock()}
    ${html}
    <p class="foot">Tango Buddy · Boston · ideas in progress — we would love your take.</p>
  `);
}

/* ---------- footer-only meta pages (/updates /ideas /todo) ------------------ */
/* Data-driven from store.listUpdates / listIdeas / listTodos so appending a new
 * entry is just a db.json edit. Reached ONLY via the footer — never in the top
 * menu. Ideas + Updates carry NO money language (features/experiences only). */

function metaPage(opts) {
  const items = opts.items.length ? opts.items.map((it) => `
    <div class="soon">
      ${it.tag ? `<span class="tease" style="margin:0 0 8px">${esc(it.tag)}</span>` : ''}
      <h3>${esc(it.title)}</h3>
      <p>${esc(it.note)}</p>
    </div>`).join('')
    : `<div class="card"><p class="empty">Nothing here yet — check back soon.</p></div>`;
  return page(opts.title, `
    <span class="badge">${esc(opts.badge)}</span>
    <h1>${opts.heading}</h1>
    <p class="lede">${esc(opts.lede)}</p>
    ${items}
    <p class="foot">Tango Buddy · Boston · ${esc(opts.footNote)}</p>
  `);
}

async function updatesPage() {
  const items = (await store.listUpdates()).map((u) => ({
    tag: 'v' + u.version, title: 'v' + u.version, note: u.note,
  }));
  return metaPage({
    title: "Tango Buddy — Updates",
    badge: "Updates · What we've added",
    heading: `What we've <span class="accent">added</span>`,
    lede: 'The story of Tango Buddy so far — newest first.',
    footNote: 'always growing, always warmer.',
    items,
  });
}

async function ideasPage() {
  const items = await store.listIdeas();
  return metaPage({
    title: 'Tango Buddy — Ideas',
    badge: "Ideas · What's possible",
    heading: `What's <span class="accent">possible</span>`,
    lede: 'This is where we collect ideas and possibilities for where Tango Buddy could go. Dreaming out loud — all about keeping people dancing.',
    footNote: 'ideas welcome — tell us what you would love.',
    items,
  });
}

async function todoPage() {
  const items = await store.listTodos();
  return metaPage({
    title: 'Tango Buddy — To-do',
    badge: 'To-do · Upcoming (approved)',
    heading: `Upcoming <span class="accent">(approved)</span>`,
    lede: 'The next things we have agreed to build.',
    footNote: 'on deck — coming to a milonga near you.',
    items,
  });
}

/* ---------- page: More — outbound links (GET /more) ------------------------- */
/* Warm hand-offs to the wider tango world. Outbound links open in a new tab.
 * PUBLIC page — kept money-free (no pricing/payments/$ language). */

function morePage() {
  return page('Tango Buddy — More', `
    <span class="badge">More Boston Tango</span>
    <h1>More <span class="accent">tango near you</span></h1>
    <p class="lede">A couple of warm places to keep exploring the dance beyond Tango Buddy —
      open either one and wander.</p>
    <div class="card teacher">
      <h3>Boston Tango Calendar</h3>
      <p>Everything happening on Boston's dance floors, gathered in one local calendar —
        milongas, practicas and classes across the city, night by night.</p>
      <div class="ctas">
        <a href="https://bostontangocalendar.com" target="_blank" rel="noopener">Open Boston Tango Calendar →</a>
      </div>
    </div>
    <div class="card teacher">
      <h3>TangoTiempo <span style="font-weight:600;color:#a98a76">(national)</span></h3>
      <p>The wider tango world — events, organizers and communities across the country,
        all connected in one place. Where Tango Buddy's events come from.</p>
      <div class="ctas">
        <a href="https://tangotiempo.com" target="_blank" rel="noopener">Open TangoTiempo →</a>
      </div>
    </div>
    <p class="foot">Tango Buddy · Boston · the dance is bigger than one app.</p>
  `);
}

/* ---------- page: admin passphrase gate (when ADMIN_PASS is set) ------------ */

function adminGatePage(wrong) {
  const msg = wrong
    ? '<p class="promise"><b>That passphrase did not match.</b> Try again.</p>' : '';
  return page('Tango Buddy — Admin', `
    <span class="badge">Operator Dashboard</span>
    <h1>Admin <span class="accent">passphrase</span></h1>
    <p class="lede">This dashboard is protected. Enter the operator passphrase to continue.</p>
    ${msg}
    <div class="card">
      <form method="GET" action="/admin">
        <label class="fld" for="pass">Passphrase</label>
        <input id="pass" name="pass" type="password" autocomplete="current-password"
          placeholder="Operator passphrase" required />
        <button class="submit" type="submit">Enter</button>
      </form>
    </div>
    <p class="foot">Tango Buddy · Boston · operators only.</p>
  `);
}

/* ---------- static asset serving (/assets/*) -------------------------------- */

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.css': 'text/css', '.txt': 'text/plain',
};

function serveAsset(res, pathname) {
  // Only ever serve from ASSETS_DIR; strip the leading /assets/ and any traversal.
  const rel = decodeURIComponent(pathname.replace(/^\/assets\//, ''));
  const filePath = path.join(ASSETS_DIR, rel);
  if (!filePath.startsWith(ASSETS_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain'); // graceful if missing
    send(res, 200, buf, MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  });
}

/* ---------- router ---------------------------------------------------------- */

// The core request handler. Exported so BOTH `node server.js` (local) AND the
// Vercel serverless function (api/index.js) can drive the exact same app.
async function requestListener(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    // --- GET routes ---
    if (req.method === 'GET') {
      if (pathname === '/') return send(res, 200, rootShell());

      // --- V1.0.0 (C5): crawler contract. Both of these 404'd before, which (with
      // the blanket noindex) meant Google could verify the domain and index
      // NOTHING. PUBLIC_ROUTES is the single source of truth for the sitemap and
      // it is an allow-list: a route only gets crawled if it is named here AND
      // its page() call passes index:true.
      if (pathname === '/robots.txt') {
        return send(res, 200, [
          'User-agent: *',
          'Allow: /',
          'Disallow: /admin',
          'Disallow: /api/',
          `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
          '',
        ].join('\n'), 'text/plain; charset=utf-8');
      }
      if (pathname === '/sitemap.xml') {
        const urls = PUBLIC_ROUTES
          .map((p) => `  <url><loc>${esc(SITE_ORIGIN + p)}</loc></url>`)
          .join('\n');
        return send(res, 200,
          `<?xml version="1.0" encoding="UTF-8"?>\n`
          + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
          'application/xml; charset=utf-8');
      }
      // The version used to be visible in the drawer footer; the drawer is hidden
      // at launch, so this is where the running build identifies itself.
      if (pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, app: 'boston-tango-buddies', version: VERSION });
      }
      if (pathname === '/signup') return send(res, 200, signupPage(url.searchParams.get('flash')));
      if (pathname === '/welcome') return send(res, 200, welcomePage());
      // The group airlock. noindex by default (fail-closed page()) and NOT in
      // PUBLIC_ROUTES, so it never reaches the sitemap — see groupPage's header.
      if (pathname === '/group') return send(res, 200, groupPage());
      // V1.1.0 (D5): /volunteer is now behind the BUDDY tier. Toby hands the link
      // and phrase to people he has vetted; buddies are invited, not self-serve.
      if (pathname === '/volunteer') {
        if (!buddyOK(req, url)) {
          const tried = url.searchParams.get('pass');
          return send(res, 200, buddyGatePage(!!tried));
        }
        // Phrase supplied via ?pass= -> drop the BUDDY cookie (never the admin
        // one) and land back on a clean /volunteer.
        if (BUDDY_PASS && url.searchParams.get('pass') === BUDDY_PASS) {
          res.writeHead(302, {
            'Set-Cookie': `${BUDDY_COOKIE}=${encodeURIComponent(BUDDY_PASS)}; Path=/; HttpOnly; SameSite=Lax`,
            Location: '/volunteer',
          });
          return res.end();
        }
        return send(res, 200, volunteerPage(url.searchParams.get('flash')));
      }
      if (pathname === '/lessons') return send(res, 200, await lessonsPage());
      // Organizers are no longer a public browse page — they live on events (and
      // stay manageable in /admin). The old /teachers route now points at Lessons.
      if (pathname === '/teachers') return redirect(res, '/lessons');
      if (pathname === '/events') return send(res, 200, await eventsPage(url.searchParams.get('flash')));
      if (pathname === '/admin') {
        // Admin gate for the public deploy (open when ADMIN_PASS is unset).
        if (!adminOK(req, url)) {
          const tried = url.searchParams.get('pass');
          return send(res, 200, adminGatePage(!!tried));
        }
        // Passphrase supplied via ?pass= → drop the cookie, then land on /admin.
        if (ADMIN_PASS && url.searchParams.get('pass') === ADMIN_PASS) {
          res.writeHead(302, {
            'Set-Cookie': `${ADMIN_COOKIE}=${encodeURIComponent(ADMIN_PASS)}; Path=/; HttpOnly; SameSite=Lax`,
            Location: '/admin',
          });
          return res.end();
        }
        return send(res, 200, await adminPage(url.searchParams.get('flash')));
      }
      // V1.0.0 (C3): /chat is REMOVED from the product — unreachable, unlinked,
      // unindexed. The chatPage() implementation and the /api/chat POST handler are
      // deliberately RETAINED, dead but intact: restoring chat is deleting this
      // redirect and restoring the line beneath it. Deleting working code at the
      // moment of launch is free today and expensive later.
      if (pathname === '/chat') return redirect(res, '/events');
      // if (pathname === '/chat') return send(res, 200, await chatPage({
      //   id: url.searchParams.get('id'), as: url.searchParams.get('as'),
      // }));
      // 🔴 V1.1.0 (D6): the seven removed routes. UNREACHABLE, implementations
      // retained in the file exactly as agreed for /chat — deleting these six
      // lines restores them.
      //
      // /social was an ACTIVE PII LEAK on production: socialPage() builds a
      // <datalist> from listNewbies(), so from the moment real people landed in
      // D1 the page served every newcomer's name to anyone who asked. They gave
      // a phone number at a tango event expecting to be contacted about tango;
      // they did not consent to being listed on a public web page.
      //
      // Killing POST /api/social was only half of D6 — the READ path leaked
      // without any write. Lesson worth keeping: "disable the endpoint" and
      // "make the route unreachable" are two different jobs, and for a page that
      // RENDERS personal data the second one is the urgent half.
      if (pathname === '/social'
        || pathname === '/coming'
        || pathname === '/more'
        || pathname === '/updates'
        || pathname === '/ideas'
        || pathname === '/todo') {
        return redirect(res, '/');
      }
      // 🔴 V1.1.0 (D6): DISABLED — the READ half of the messaging removal.
      //
      // This was unauthenticated and returned every message in any thread to
      // anyone who named it. No enumeration was even needed: the social thread's
      // id is the hardcoded constant 'thread_social' (store.js SOCIAL_ID), so
      // GET /api/thread?id=thread_social returned the whole room. Buddy threads
      // use random ids, but a random id is not an access control.
      //
      // Caught by auditing read paths after the /social incident. It held only
      // test chatter today, which is exactly why it was easy to miss: same
      // dormant shape as socialPage() — safe on fake data, a leak the instant
      // real conversations exist. Messaging is gone (D6a, chat is now an
      // external group), so nothing consumes this. store functions and the
      // threads/messages data are untouched, per D6.
      if (pathname === '/api/thread') {
        return sendJson(res, 410, { error: 'in-app messaging has been removed' });
      }
      // v0.8.1: LIVE feed of the beginnerFriendly SUPERSET (next 2 weeks) from the
      // MasterCalendar API, RRULE-expanded + cached (~15 min); each occurrence
      // carries BOTH forBeginners + beginnerFriendly flags so /events can split
      // into tiers. Never throws — returns { events:[], live:false } on ANY
      // failure so callers stay safe.
      if (pathname === '/api/events-live') {
        return sendJson(res, 200, await getLiveEvents());
      }
      // V1.2: token device-landing lookup — the with-token home fetches this to
      // render "welcome back" + upcoming events + the newbie's own check-ins.
      if (pathname === '/api/me') {
        const token = url.searchParams.get('token');
        const newbie = token ? await store.findNewbieByToken(token) : null;
        if (!newbie) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, {
          // Only expose what the home needs (no contact / consent leakage).
          newbie: { id: newbie.id, name: newbie.name, status: newbie.status },
          // D6a: the group invite is delivered HERE, behind the token check, and
          // never embedded in any page — not in markup, not in an inline script.
          // An invite link is a permanent open door for whoever holds it, and a
          // scraper reads inline <script> source just as easily as a <a href>.
          groupUrl: WHATSAPP_GROUP_URL,
          events: await store.listEvents(),
          checkins: await store.listCheckinsForNewbie(newbie.id),
        });
      }
      // V1.2: PWA add-to-home-screen manifest (icons degrade gracefully if the
      // referenced /assets/icon.png is absent — the OS just uses a default).
      if (pathname === '/manifest.webmanifest') {
        const manifest = {
          name: 'Boston Tango Buddies',
          short_name: 'Tango Buddies',
          description: SITE_DESC,
          start_url: '/',
          display: 'standalone',
          background_color: '#fff6ee',
          theme_color: '#c85a3c',
          icons: [
            { src: '/assets/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/assets/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        };
        return send(res, 200, JSON.stringify(manifest, null, 2),
          'application/manifest+json; charset=utf-8');
      }
      if (pathname.startsWith('/assets/')) return serveAsset(res, pathname);
      if (pathname === '/favicon.ico') return serveAsset(res, '/assets/icon.png');
      return send(res, 404, page('Not found', '<div class="card"><h1>Not found</h1><p class="lede">No such page. <a href="/">Home</a>.</p></div>'));
    }

    // --- POST routes (form submissions) ---
    if (req.method === 'POST') {
      const body = await parseBody(req);

      // Admin gate: the /admin-driven POST routes require the passphrase when
      // ADMIN_PASS is set. Newbie/token/chat flows below stay open (no login).
      const ADMIN_POSTS = ['/api/match', '/api/event', '/api/event/update',
        '/api/event/tt', '/api/event/refresh',
        '/api/organizer', '/api/organizer/update', '/api/studio', '/api/studio/update',
        '/api/ready', '/api/handover'];
      if (ADMIN_POSTS.includes(pathname) && !adminOK(req, url)) {
        return send(res, 403, 'Forbidden — admin passphrase required.', 'text/plain');
      }

      if (pathname === '/api/newbie') {
        // V1.1.0 (D7): REAL server-side validation. The comment that used to sit
        // here claimed consent was guarded server-side; it was not, and a blank
        // POST created a real empty row with a real token — the person then saw
        // a thank-you screen for a record that was useless. Never write a partial
        // record. (D1a will add firstName/lastName/contact2/wantsBuddy here once
        // store.addNewbie persists them — deliberately NOT validated yet, because
        // requiring fields the store would silently drop is worse than not asking.)
        const problems = requireFields(body, [
          ['firstName', 'your first name'],
          ['lastName', 'your last name'],
          ['platform', 'how to reach you'],
          ['contact', 'a way to reach you'],
        ]);
        // D1a: wantsBuddy is REQUIRED so we never have to infer it. "no" is a
        // perfectly good answer; what we refuse to accept is silence, because an
        // unanswered question later becomes a guess about a real person.
        if (body.wantsBuddy !== 'yes' && body.wantsBuddy !== 'no') {
          problems.push('whether you would like a buddy');
        }
        if (!isChecked(body.consent)) problems.push('your consent to be contacted');
        if (problems.length) return rejectPost(req, res, '/signup', problems);
        // dancedBefore / dancedTangoBefore stay OPTIONAL and are passed through
        // only when answered — an empty select must reach the store as absent, so
        // it records "not asked" rather than asserting "no". Same rule Franklin
        // baked into addNewbie (7ae20ad): absent is never coerced to false.

        // V1.2: mint the device token and return it so the client can save it to
        // localStorage (tb_token). AJAX callers ask for JSON; a plain no-JS POST
        // still redirects to the server-rendered thank-you.
        const newbie = await store.addNewbie(body);
        if ((req.headers.accept || '').includes('application/json')) {
          return sendJson(res, 200, { token: newbie.token });
        }
        return redirect(res, '/signup?flash=thanks');
      }
      if (pathname === '/api/volunteer') {
        // 🔴 D5: gate the ENDPOINT, not just the page. /volunteer sits behind
        // BUDDY_PASS so Toby controls who joins the buddy pool, but this POST had
        // no gate at all — anyone could insert themselves as a buddy by posting
        // directly, walk straight past the door, and land in the assign-buddy
        // dropdown ready to be matched with a newcomer. Buddies are people Toby
        // recruits and vets; an unvetted stranger being handed a nervous
        // newcomer is the worst failure this product has.
        //
        // Same shape as the /social leak and GET /api/thread: gating the page
        // while leaving its endpoint open is not gating anything.
        if (!buddyOK(req, url)) {
          return send(res, 403, 'Forbidden — buddy passphrase required.', 'text/plain');
        }
        // D7: a buddy record with no contact is unusable, and an empty one
        // silently occupies a slot in the assign-buddy dropdown.
        const problems = requireFields(body, [
          ['name', 'your name'],
          ['contact', 'a way to reach you'],
          ['area', 'your Boston area'],
        ]);
        if (problems.length) return rejectPost(req, res, '/volunteer', problems);
        await store.addVolunteer(body);
        return redirect(res, '/volunteer?flash=thanks');
      }
      if (pathname === '/api/match') {
        await store.setMatch(body.newbieId, body.volunteerId);
        return redirect(res, '/admin');
      }
      // --- V1.1 endpoints ---
      // Public: a newbie checks into an event (no login — newbieId from dropdown).
      if (pathname === '/api/checkin') {
        // Two front doors, same store call: the /events dropdown sends newbieId;
        // the V1.2 token home sends a token (frictionless one-tap, no dropdown).
        let newbieId = body.newbieId;
        if (!newbieId && body.token) {
          const n = await store.findNewbieByToken(body.token);
          if (n) newbieId = n.id;
        }
        if (newbieId && body.eventId) {
          await store.checkIn(newbieId, body.eventId, body.status);
        }
        if ((req.headers.accept || '').includes('application/json')) {
          return sendJson(res, 200, { ok: true });
        }
        return redirect(res, '/events?flash=checkedin');
      }
      if (pathname === '/api/event') {
        await store.addEvent(body);
        return redirect(res, '/admin');
      }
      if (pathname === '/api/event/update') {
        await store.updateEvent(body.eventId, body);
        return redirect(res, '/admin');
      }
      // Admin: add an event by pasting a TangoTiempo link/id — server pulls the
      // real fields (shortName / organizer / date / venue / icon) and stores them.
      if (pathname === '/api/event/tt') {
        const data = await fetchTangoTiempoEvent(body.tt);
        if (!data) return redirect(res, '/admin?flash=ttfail');
        await store.addEvent({ ...data, source: 'TangoTiempo' });
        return redirect(res, '/admin?flash=ttadded');
      }
      // Admin: re-pull a stored TangoTiempo event's fields from the live API.
      if (pathname === '/api/event/refresh') {
        const ev = (await store.listEvents()).find((e) => e.id === body.eventId);
        const data = ev ? await fetchTangoTiempoEvent(ev.ttId || ev.url || ev.link) : null;
        if (!data) return redirect(res, '/admin?flash=ttfail');
        await store.updateEvent(body.eventId, data);
        return redirect(res, '/admin?flash=ttrefreshed');
      }
      if (pathname === '/api/organizer') {
        await store.addOrganizer(body);
        return redirect(res, '/admin');
      }
      if (pathname === '/api/organizer/update') {
        await store.updateOrganizer(body.orgId, body);
        return redirect(res, '/admin');
      }
      if (pathname === '/api/studio') {
        await store.addStudio(body);
        return redirect(res, '/admin');
      }
      if (pathname === '/api/studio/update') {
        await store.updateStudio(body.studioId, body);
        return redirect(res, '/admin');
      }
      if (pathname === '/api/ready') {
        await store.setReady(body.newbieId, body.ready);
        return redirect(res, '/admin');
      }
      if (pathname === '/api/handover') {
        await store.setHandover(body.newbieId, body.organizerId);
        return redirect(res, '/admin');
      }
      // 🔴 V1.1.0 (D6): DISABLED. In-app messaging is gone — chat is now an
      // external group link. These endpoints were live, unauthenticated, and
      // carried three separate holes:
      //   1. OPEN REDIRECT — `body.redirect` was echoed straight into a 302, so
      //      a link reading as bostongtangobuddies.com could land a newcomer on
      //      any site an attacker chose. Aimed at people who had just been asked
      //      to trust this domain with their name and phone number.
      //   2. IMPERSONATION — `fromName` was arbitrary free text, so anyone could
      //      post as anyone.
      //   3. No auth at all — no token, no gate.
      // Removing the PAGES was not enough: an unreachable page with a live write
      // endpoint is not removed. The implementations above are retained intact;
      // this rejection is the one-line revert point.
      if (pathname === '/api/chat' || pathname === '/api/social') {
        return sendJson(res, 410, { error: 'in-app messaging has been removed' });
      }
      return send(res, 404, 'Not found', 'text/plain');
    }

    send(res, 405, 'Method not allowed', 'text/plain');
  } catch (e) {
    console.error('Server error:', e);
    send(res, 500, 'Server error', 'text/plain');
  }
}

// Only create/listen on a real http.Server when run directly (`node app.js`).
// Creating an http.Server at module top-level trips Vercel's server-detection
// and crashes the serverless handler ("default export must be a function or
// server"). On Vercel the handler just imports `requestListener` below.
if (require.main === module) {
  const server = http.createServer(requestListener);
  server.listen(PORT, () => {
    console.log(`Tango Buddy POC running -> http://localhost:${PORT}`);
    console.log(`Store backend: ${store.USE_FIRESTORE ? 'Firestore (firebase-admin)' : 'local JSON (data/db.json)'}`);
    console.log('Public: /  /signup  /events  /lessons  /welcome  ·  robots.txt  sitemap.xml');
    console.log('Unlinked (URL only): /volunteer  /social  /coming  /more  /updates  /ideas  /todo  /admin');
  });
}

// Default export IS the (req, res) handler, so whichever file Vercel resolves
// as the function handler is valid. Named export kept for existing callers.
module.exports = requestListener;
module.exports.requestListener = requestListener;
