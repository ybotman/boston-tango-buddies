# Tango Buddy — POC demo

A **throwaway proof-of-concept** for _Tango Buddy_: a Boston tango newcomer
on-ramp & retention tool. It proves the whole thesis end to end — capture a
**newbie** (with **origination** / how-they-found-us), capture a **volunteer
buddy**, and let an operator **hand-match** them — plus a **Lessons** tab of real
Boston studios, a public **events** listing with **check-in**, and a **studio
handover** that connects the community layer to the lessons layer.

> **v0.8.1 — `/events` is now a THREE-TIER layout (mobile-first, no login).**
> `eventsLive.js` fetches the **beginnerFriendly=true SUPERSET** once (this set already
> includes the `forBeginners` events; each normalized occurrence still carries **both**
> `forBeginners` and `beginnerFriendly` booleans), same next-7-days window / pagination /
> RRULE expansion / ~15-min cache / `{events:[],live:false}` on failure. The `/events`
> page **splits that one fetch by flag** into two rendered sections plus a link tier:
> **Tier 1 "For beginners"** (`forBeginners === true`, "Made for newcomers — come as you
> are.", shown first) → **Tier 2 "Feeling a bit more adventurous?"** (`beginnerFriendly
> === true` AND `forBeginners !== true`, "Still welcoming, a little more going on.") →
> **Tier 3 "Even more"** (money-free: "Want the full Boston calendar? → **tangotiempo.com**"
> new tab, and always **"ask your buddy."**). **Empty tiers hide their heading.** If BOTH
> live tiers are empty or `live:false`, it falls back to the stored **seed** under a single
> "Beginner nights" heading with the "showing saved picks" note (as v0.8.0). Both tiers
> reuse `eventCardHtml`; cards deep-link to `tangotiempo.com/event/<id>`.
>
> **v0.8.0 — `/events` is now a LIVE feed from the MasterCalendar/TangoTiempo API.**
> `/events` no longer lists the stored seed — it renders **beginner nights for the
> next 7 days** pulled **server-side** from our own public backend
> (`GET https://calendarbeaf-prod.azurewebsites.net/api/events` with
> `appId=1&useGeoSearch=true&lat=42.3601&lng=-71.0589&radius=50mi&forBeginners=true&start=…&end=…&limit=500`),
> paginating until `page === pages`. Recurring events come back as **masters with an
> RRULE** (`recurrenceRule`) — a new server module **`eventsLive.js`** expands them
> **client-of-the-API-side** with the **`rrule`** dep (new dependency): anchor
> `DTSTART = startDate`, `rrulestr(...).between(windowStart, windowEnd, true)`,
> preserving time-of-day; one-offs are included if their `startDate` is in-window.
> Occurrences are normalized to
> `{ id, url:'https://tangotiempo.com/event/<id>', shortName, orgName, date, venueName, category, image, forBeginners, beginnerFriendly }`,
> sorted ascending, and **cached in-memory (~15 min TTL)**. A new endpoint
> **`GET /api/events-live`** returns `{ events, live, window }` on success or
> **`{ events:[], live:false }` on ANY failure** (network / non-200 / parse — never
> throws). The `/events` page server-renders from the same cached logic; heading is
> "**Beginner nights — next 7 days**" ("Events made for newcomers, near Boston. Come
> as you are."). **Fallback:** if the live feed is empty or `live:false`, the page
> falls back to the stored **seed events** (`store.listEvents()`, the current 4) with
> a small "showing saved picks" note, so it never blanks. A money-free **"Want more?"**
> block at the bottom links the whole Boston calendar → **tangotiempo.com** (new tab)
> and emphasizes **"ask your buddy."** The `data/db.json` seed (4 events / 9 studios)
> is kept intact as the fallback.

> **v0.7.1 — events = beginner-friendly only + local `/tmp` store footgun fixed.**
> The `/events` tab now shows **beginner-friendly events only** — the buddy is the
> door to everything else. Copy is reframed to a warm beginner heading
> ("**Beginner-friendly nights**" + "These are the events made for newcomers — come
> as you are. Want more than this? **Ask your buddy.**"), money-free. The
> TangoTiempo fetch helper (`tangotiempo.js`) now reads the API's
> `beginnerFriendly` / `forBeginners` (+ `…Override`) flags and computes **one
> normalized `beginnerFriendly` boolean** (overrides win when present; any
> for/friendly flag true ⇒ true), stored on each event by `store.js`
> (`addEvent`/`updateEvent`, both backends). `/events` filters to
> `beginnerFriendly !== false` — **manual-curation-wins**: a missing/unknown flag
> defaults to **shown**, so the 4 hand-picked seed events (all seeded
> `beginnerFriendly: true`) stay visible and the filter never empties the page.
> **Store footgun fix:** the `/tmp/db.json` read-preference AND write-redirect are
> now **`VERCEL`-gated** — they run **only** when `process.env.VERCEL` is set. In
> local dev (no `VERCEL`) reads and writes use `data/db.json` **exclusively**, never
> `/tmp`, so local testing can't be shadowed/corrupted by a stale `/tmp/db.json`.
> Vercel behavior (read-only FS → `/tmp`) is unchanged.

> **v0.7.0 — landing/routing split + bottom-drawer footer.** The old client-side
> token-split at `/` is now **three distinct routes**. **`/signup`** is the
> **capture form** (the **QR target**) — same hero copy ("Thanks for scanning.
> Want to learn tango?"), same `POST /api/newbie` token mint; on success the client
> saves `tb_token` and routes to `/`. **`/welcome`** is a warm **no-cookie intro**
> (money-free) for someone landing without a token — a **Get started** button →
> `/signup` plus a returner line. **`/`** is now a tiny **smart router shell** that
> **never shows the signup form**: it reads `localStorage.tb_token` and either
> renders the returning **home** (Welcome back + Events one-tap check-in + history +
> quiet links) or `location.replace('/welcome')` (with a `<noscript>` link to
> `/welcome`). The static footer became a **bottom drawer / sheet**: a slim handle
> pinned to the bottom of the viewport slides a panel up (scrim + swipe-down/grip/
> Esc to close) holding **Be a buddy · Admin · Coming · More** + the meta line
> **Tango Buddy v0.7.0 · Updates · Ideas · To-do**. Mobile-first, safe-area aware,
> progressive-enhancement (`<noscript>` static footer). The top nav's **Learn tango**
> now points at `/signup`. _(The drawer will later be gated/authenticated.)_

> **v0.6.0 — TangoTiempo event integration.** Events are now **pulled from
> TangoTiempo**. A tiny server-side helper `fetchTangoTiempoEvent(idOrUrl)`
> (`tangotiempo.js`, zero deps — Node 18+ global `fetch`) accepts a full
> `https://tangotiempo.com/event/<id>` link **or** a bare 24-hex id, calls
> `GET https://tangotiempo.com/api/events/id/<id>`, and returns a normalized
> `{ ttId, url, shortName, orgName, title, startDate, venueName, category, image }`
> (or **`null`** on any bad id / network / non-200 — never throws). The 4 seed
> events hold **real fetched data** (CAMBRIDGE-Al-Fresco! / Ochos & Pivots /
> Beginner Class / Beginner %100). The public `/events` cards are **mobile-first**:
> a rounded **icon** (hidden when absent), the **shortName** (bold) then the
> **organizer** name, a pretty date + category pill + venue — and the **whole card
> deep-links to its TangoTiempo page** (`target="_blank"`). In `/admin` an operator
> **adds an event by pasting a TangoTiempo link/id** (→ `POST /api/event/tt`, auto-
> pulls all fields) and can **Refresh from TangoTiempo** per event (→ `POST
> /api/event/refresh`). Event icons are external Azure-blob URLs referenced directly.

> **v0.5.0 — Lessons tab + model split.** A real **Lessons tab** (`/lessons`) now
> lists 9 real Boston teaching studios as mobile cards with **Call** (`tel:`) and
> **Website** CTAs. The data model is **split into two collections**: **organizers**
> (attached to **events** — who hosts milongas/practicas) and a NEW **studios /
> teachers** collection (attached to **lessons** — the Lessons tab). Both are
> managed separately in `/admin` ("Organizers (events)" vs "Studios / Teachers
> (lessons)"). The old `/teachers` route now **302-redirects to `/lessons`**.

> **v0.4.0 — release-ready.** The agreed stack is **Vercel** (host + serverless
> functions) + **Firebase Firestore** (store). This POC ships **deploy-ready**:
> the store is **env-gated** (Firestore when Firebase envs are present, local
> JSON file otherwise) and a Vercel serverless catch-all wraps the existing app.
> **Locally it still runs with zero dependencies and zero cloud** — `node
> app.js` uses the JSON file. See "Swappable data layer" and "Deploy to
> Vercel" below.

## Run it

Local dev needs only a stock Node.js install (v18+) and **no `npm install`** — the
one dependency (`firebase-admin`) is `require`d lazily and only when the Firebase
envs are set, so the local JSON path never touches it.

```bash
cd poc
node app.js
```

Then open **http://localhost:3000**. Stop with `Ctrl-C`.
(Set a different port with `PORT=4000 node app.js`.) The startup log prints the
active store backend (`local JSON` vs `Firestore`).

## Routes

| Route         | What it is                                                              |
|---------------|-------------------------------------------------------------------------|
| `GET /`       | **Smart router shell (v0.7.0)** — a tiny client-side shell that **never shows the signup form**. Reads `localStorage.tb_token`: **has token →** renders the returning **home** (`GET /api/me?token=…`): "Welcome back, &lt;name&gt;" + upcoming **Events with one-tap check-in** (token-based, no dropdown) + check-in history + quiet links to buddy chat & the social feed + a **Bring a buddy** share + "Not you? Start over". **No token →** `location.replace('/welcome')`. `<noscript>` falls back to a `/welcome` link. |
| `GET /signup` | **Newbie capture form (v0.7.0 — the QR target).** Same hero copy ("Thanks for scanning. Want to learn tango?" + the free-first-lesson/tango-buddy promise). Name, contact, platform, **"How did you find us?" (origination)**, note, required consent. On submit → AJAX `POST /api/newbie` mints a device **token** (saved to `localStorage.tb_token`), a **thank-you** screen shows, then a link routes to `/` (which renders the home). No-JS falls back to a plain POST → `/signup?flash=thanks` card. |
| `GET /welcome`| **No-cookie welcome (v0.7.0).** A warm, money-free intro for someone landing **without a token** (the `/` router sends them here). Who we are (buddy + free first lesson, nobody learns alone), a primary **Get started** button → `/signup`, and a quieter returner line ("Been here before? Your phone should remember you — if it doesn't, just sign up again"). Keeps the BTB hero. |
| `GET /api/me?token=…` | Returns `{ newbie:{id,name,status}, events:[…], checkins:[…] }` for the with-token home. 404 if the token is unknown (client then clears it and shows the form). |
| `GET /manifest.webmanifest` | PWA **add-to-home-screen** manifest (name "Boston Tango Buddies", short_name "Tango Buddies", `display:standalone`, warm theme/background, `start_url:"/"`, icons → `/assets/icon.png`). `application/manifest+json`. |
| `GET /volunteer` | **Volunteer (buddy) capture** — the other side. Name, contact, Boston area, availability, note. → `POST /api/volunteer` |
| `GET /events`    | **Events — LIVE 3-tier beginner feed, next 7 days (v0.8.1).** Server-renders from **one** `beginnerFriendly=true` SUPERSET fetch (today 00:00 → +7 days, near Boston, all pages) via `eventsLive.js` — masters **RRULE-expanded** (`rrule` dep), one-offs if in-window, cached ~15 min — then **split by flag** into **Tier 1 "For beginners"** (`forBeginners`) and **Tier 2 "Feeling a bit more adventurous?"** (`beginnerFriendly` minus `forBeginners`); **empty tiers hide their heading**. Mobile-first cards (`eventCardHtml`): **icon** (hidden when absent), **shortName** (bold) then **organizer**, occurrence date/day + category pill + venue; **whole card deep-links to `tangotiempo.com/event/<id>`** (`target="_blank"`). **Fallback:** both tiers empty / `live:false` → stored seed (`store.listEvents()`) under a single "Beginner nights" heading + "showing saved picks" note. **Tier 3 "Even more"** block links **tangotiempo.com** (new tab) + emphasizes **"ask your buddy."** |
| `GET /lessons`  | **Lessons tab (v0.5.0)** — the 9 **real** Boston teaching studios (Alla Tango, Blue Tango, Foundry/Roger Wood, Queer Tango Boston, Tango Academy of Boston, Tango Affair, Tango Society of Boston, Tango Spark, Ultimate Tango) as mobile cards. Each card: studio name + a **Call** button (`tel:`, only if a phone exists) + a **Website** button (opens in a new tab, only if a web exists). Warm, money-free intro. This is the **studios/teachers** collection — SEPARATE from the event **organizers**. The newbie "I want lessons" intent (with-token home) links here. |
| `GET /teachers`  | **302-redirects to `/lessons`** (v0.5.0). Organizers are no longer a public browse page — they live on events and stay manageable in `/admin`. |
| `GET /more`      | **v0.4.0 — More.** Two warm outbound links (open in a new tab): **Boston Tango Calendar** (bostontangocalendar.com) and **TangoTiempo** (tangotiempo.com, national). Linked from the **footer**. Money-free. |
| `GET /admin`     | **Operator dashboard** — tables of newbies + volunteers, per-newbie **match** control (→ `POST /api/match`), **origination** column, per-newbie **check-in history** (the retention signal), **"Ready for lessons"** toggle (→ `POST /api/ready`) + **handover to an organizer** (→ `POST /api/handover`), plus **manage events** — **v0.6.0: add an event by pasting a TangoTiempo link/id** (→ `POST /api/event/tt`, auto-pulls shortName/org/date/venue/icon; friendly error if the fetch fails), **Refresh from TangoTiempo** per event (→ `POST /api/event/refresh`), and edit rows (→ `POST /api/event/update`) — and — as **two clearly separate sections** (v0.5.0) — **Organizers (events)** (add → `POST /api/organizer`, edit → `POST /api/organizer/update`) and **Studios / Teachers (lessons)** (add → `POST /api/studio`, edit → `POST /api/studio/update`), and current pairings. **v0.4.0 — passphrase gate:** when `ADMIN_PASS` is set, `/admin` (+ its POST routes) require the passphrase (via `?pass=…` → cookie); unset (local dev) → open. |
| `GET /chat`      | **Buddy ↔ Newbie chat** — private 1:1 thread for a matched pairing. **No login:** a "view as" switch lets you pick a pairing and speak as either the newbie or the buddy. Polls `GET /api/thread?id=…` every ~3s. Posts → `POST /api/chat`. Empty state points you to `/admin` to make a match first. |
| `GET /social`    | **Rolling Newbies** — one open group feed the whole newbie cohort shares. Pick or free-type a "posting as" name and post. Same ~3s poll. Posts → `POST /api/social`. |
| `GET /coming`    | **What's Coming** — enticing "coming soon" cards (Buddy Card, Community chat, and preview cards). The **Buddy Card stays preview-only here.** **Features & ideas only — no money language anywhere** (no pricing/payments/revenue/$). |
| `GET /updates`   | **Updates — "What we've added"** — the release story, newest first (v0.2.0 → v0.0.x). **Footer-only page** (not in the top menu). Data-driven from `store.listUpdates()`. |
| `GET /ideas`     | **Ideas — "What's possible"** — where we collect ideas/possibilities for where Tango Buddy could go (Buddy Card, community network, rolling lifecycle, organizer↔community chat, multi-city, deeper TangoTiempo link). **Features/ideas only — no money language.** **Footer-only page.** Data-driven from `store.listIdeas()`. |
| `GET /todo`      | **To-do — "Upcoming (approved)"** — the next agreed things to build (token device-landing, real organizers, rolling lifecycle demo). **Footer-only page.** Data-driven from `store.listTodos()`. |
| `GET /api/thread?id=…` | Returns `{ id, messages: [...] }` (oldest-first) for the chat/social pollers. |
| `GET /api/events-live` | **v0.8.1.** Server-side LIVE beginner-event feed. Fetches **all pages** of the `beginnerFriendly=true` SUPERSET (includes the `forBeginners` events; each occurrence carries **both** flags) near Boston from `calendarbeaf-prod.azurewebsites.net/api/events` for the **next-7-days** window, **RRULE-expands** recurring masters (`rrule`) into dated occurrences (one-offs included if in-window), normalizes + sorts ascending, and **caches ~15 min**. Success → `{ events:[…], live:true, window:{start,end} }`; **any failure → `{ events:[], live:false }`** (never throws). |
| `POST /api/newbie` | Creates a newbie **and mints a device `token`**. AJAX callers (`Accept: application/json`) get `{ token }`; a plain no-JS POST redirects to `/?flash=thanks`. |
| `POST /api/checkin` | Check-in. Accepts **either** `newbieId` **or** `token` (the with-token home's one-tap). JSON callers get `{ ok:true }`; plain posts redirect to `/events?flash=checkedin`. |
| `POST /api/event/tt` | **v0.6.0** (admin-gated). Body `tt` = a TangoTiempo link or id → `fetchTangoTiempoEvent` → stores the event with the pulled fields. Redirects `/admin?flash=ttadded`, or `?flash=ttfail` when the fetch returns `null`. |
| `POST /api/event/refresh` | **v0.6.0** (admin-gated). Body `eventId` → re-fetches by the stored `ttId`/`url` and updates the record. Redirects `/admin?flash=ttrefreshed`, or `?flash=ttfail` on failure. |
| `GET /assets/*`  | Static files if present (`hero.png`, `icon.png`, …) — 404s gracefully if missing. |

### No login — demo "view as" switch

There is **no auth anywhere** (by design — this is a local demo Toby clicks around).
Chat identity is a demo **"view as" selector**: on `/chat` you choose a matched
pairing and toggle whether you're speaking as the **newbie** or the **buddy**, then
send. On `/social` you just type (or pick) a "posting as" name. **Event check-in**
(v0.6.0) now lives on the **with-token home** — one-tap "I'm going / I went" against
the device token (`POST /api/checkin`); the public `/events` cards themselves are
pure TangoTiempo deep-links. Messages and check-ins persist in `db.json` via
`store.js` and appear live where relevant.
Code comments in `app.js` mark exactly where an operator login would gate the
`/admin`-driven POST endpoints (events, organizers, ready, handover) in production.

### "What's Coming" is features/ideas only — no money

The `/coming` page describes future features purely as **experiences** ("one card,
tango across the city"). It intentionally contains **no money language** — no pricing,
payments, payouts, revenue, cost, fees, or "$" — anywhere on the page or in the app.

### Footer → bottom drawer (the primary nav) + version

**v0.7.0 — the footer is now a bottom drawer / sheet.** Every page pins a slim
**handle** ("≡ More") to the bottom of the viewport; tapping it **slides a panel up**
from the bottom (semi-transparent **scrim** behind, close via scrim tap / grip /
**Escape** / **swipe-down**). Mobile-first: full-width, large tap targets, a smooth
CSS `transform` transition, and **safe-area-inset** aware. It's progressive
enhancement — the drawer is `hidden` until vanilla JS un-hides it, and a
`<noscript>` static footer keeps every link reachable with JS off. _(The drawer
contents will later be **gated/authenticated**; a code comment marks this.)_

Drawer contents (mobile-first, ~48px tap targets):

- **Primary actions:** **Be a buddy** (→ `/volunteer`) · **Admin** (→ `/admin`) ·
  **Coming** (→ `/coming`) · **More** (→ `/more`)
- **Meta line:** **Tango Buddy v0.7.0** · **Updates** (→ `/updates`) · **Ideas**
  (→ `/ideas`) · **To-do** (→ `/todo`)

**v0.5.4 — slimmed top nav (kept):** the top navigation is the clean **newbie-facing**
set only (**Learn tango** · **Events** · **Lessons** · **Social** · **Chat**).
**v0.7.0:** **Learn tango** now points at **`/signup`** (nothing links to the old
`/` form). **Be a buddy**, **Admin** and **Coming** live **drawer-only** now (the
routes `/volunteer`, `/admin`, `/coming` all still work). The drawer is the **only**
way to reach the meta pages — deliberately **not in the top menu**. The version
string is read once from
`package.json` at startup (`require('./package.json').version`) — **no dependency**,
one semver source of truth (bump `package.json` → footer updates).

### Token device-landing — the light, no-login identity (v0.7.0 route split)

There is still **no login**. Instead, `POST /api/newbie` mints a random **device
token**; the client saves it to `localStorage` as **`tb_token`**. **v0.7.0** splits
the old one-URL landing into **three routes**:

1. **`/signup` → the capture form** (the QR target). Submitting mints the token,
   saves it, shows a **thank-you** ("You're in! …keep this on your phone…"), then
   links to `/`. No-JS falls back to a plain POST + `/signup?flash=thanks` card.
2. **`/welcome` → the no-cookie intro** for a token-less device (money-free; **Get
   started** → `/signup`).
3. **`/` → the smart router shell** (never shows the form). **Has token →** the
   **with-token home** — fetches `GET /api/me?token=…` and renders "Welcome back,
   &lt;name&gt;", upcoming **Events with one-tap check-in** (posts the token, no
   dropdown), the newbie's **check-in history**, quiet links to their **buddy chat**
   + the **social feed**, and a **Bring a buddy** share. A **"Not you? Start over"**
   link clears `tb_token` (→ back through `/` → `/welcome`). **No token →**
   `location.replace('/welcome')`.

Token plumbing lives in `store.js` (`addNewbie` mints `newbie.token`;
`findNewbieByToken(token)` resolves it back) — the store stays the single data layer.

### Bring a buddy — Web Share (Task 4)

The **Bring a buddy** button (on the thank-you screen and the with-token home) uses
the **Web Share API** — `navigator.share({ title, text, url })` — with a graceful
**fallback** that copies the landing URL to the clipboard and flashes "link copied ✓"
(and a final `prompt()` fallback if clipboard is unavailable). Text: *"Come learn
tango with me — Boston Tango Buddies."*

### Meta / Open Graph / favicon + PWA (Tasks 5–6)

Every page's `<head>` carries a `<title>`, `<meta name="description">`, **Open Graph**
tags (`og:title` "Boston Tango Buddies", `og:description`, `og:image` → `/assets/hero.png`,
`og:type`, `og:site_name`), a `theme-color` meta, a favicon (`<link rel="icon"
href="/assets/icon.png">` + `apple-touch-icon`), and a **PWA manifest** link
(`<link rel="manifest" href="/manifest.webmanifest">`). The manifest enables
**add-to-home-screen** (standalone display, warm theme). Both icon files are
**optional** — `/assets/*` 404s gracefully and the browser/OS simply skips a missing
icon, so nothing errors if `icon.png` isn't dropped in yet. The shared description is
kept **money-free** since it renders on `/coming`, `/events` and `/ideas` too.

### Mobile-first (built for the phone: QR → phone)

This POC is **for mobile, nearly exclusively**. Every page carries
`<meta name="viewport" content="width=device-width, initial-scale=1, …">`, uses a
single-column layout that fits a ~375px screen with **no horizontal scroll**,
full-width touch-friendly inputs/buttons, and a readable 16px+ base font. The wide
`/admin` tables are wrapped in contained `.scroll` boxes so they never force the
whole page to scroll sideways. Warm brand (terracotta / coral / cream / amber) and
the `/assets/hero.png` hero are preserved throughout.

## Images (optional)

Drop `hero.png` and `icon.png` into `poc/assets/` — the pages link to them and
fall back gracefully if they're missing. See `assets/README.md`.

## Swappable data layer — env-gated Firestore / JSON (v0.4.0)

**All data access lives in one file: `store.js`.** It is the ONLY module that
knows which backend is in use, and it now supports **two backends chosen once at
runtime**:

- **Firestore** — used **only** when the Firebase service-account envs are present
  (`FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`).
  `firebase-admin` is **`require`d lazily** on that path only, so a local checkout
  without it installed never touches it. Collections: `newbies, volunteers,
  organizers, events, checkins, threads, messages, meta`.
- **Local JSON file** — the **default** (no Firebase envs): reads/writes
  `data/db.json` with Node's `fs`, exactly as before. Zero dependencies for local
  dev.

Every public `store.js` function is **async** (returns a Promise) so the one
surface works for both backends; `app.js` `await`s them. The surface is
unchanged and backend-agnostic:

```
addNewbie, listNewbies, findNewbieByToken, addVolunteer, listVolunteers, setMatch,
listTeachers, listStudios, addStudio, updateStudio,
getOrCreateBuddyThread, getRollingNewbiesThread, listMessages, postMessage,
listEvents, addEvent, updateEvent, addOrganizer, updateOrganizer,
checkIn, listCheckinsForNewbie, setReady, setHandover,
listUpdates, listIdeas, listTodos
```

### The organizers ↔ studios model split (v0.5.0)

The store holds **two separate collections**, one per feature:

- **Organizers** (`listTeachers`, `addOrganizer`, `updateOrganizer`) — the inventory
  attached to **events** (who hosts Boston's milongas / practicas / classes).
  Stored under the legacy `teachers` key in the local JSON file for back-compat;
  Firestore uses the `organizers` collection name. **These are NOT the Lessons list.**
- **Studios / Teachers** (`listStudios`, `addStudio`, `updateStudio`) — the NEW
  collection (v0.5.0) that backs the **Lessons tab** (`/lessons`). Shape
  `{ id, name, phone, web, createdAt }`. Names may overlap with organizers, but it
  is its own list. Stored under the `studios` key (local JSON) / `studios`
  collection (Firestore).

Both are editable in `/admin` under two distinct sections. The `teachers → teachers`
(organizers) key mapping lives entirely inside `store.js`.

## Environment variables

| Var | Purpose |
|-----|---------|
| `FIREBASE_PROJECT_ID`   | Firebase project id. **All three Firebase vars must be set together** to switch the store to Firestore. |
| `FIREBASE_CLIENT_EMAIL` | Service-account client email. |
| `FIREBASE_PRIVATE_KEY`  | Service-account private key (PEM). Store with literal `\n` for newlines — `store.js` restores them. **Sensitive — set via Vercel env / secrets, never commit.** |
| `ADMIN_PASS`            | Admin passphrase. When set, `/admin` (+ its POST routes) require it; **unset → admin is open (local dev)**. Newbie/token flows are never gated. |
| `PORT`                  | Local listen port (default `3000`). |

With **no** env vars set, `node app.js` runs the local JSON store with admin
open — the zero-config local experience.

## Deploy to Vercel

`vercel.json` rewrites requests to a single serverless function (`api/index.js`)
that delegates to the exact same `requestListener` exported from `app.js` — so
the app behaves identically locally (`node app.js`) and on Vercel.
`firebase-admin` is a declared dependency (installed on Vercel; only imported when
the Firebase envs are present).

> **v0.5.1 — Vercel deployability fix.** Two things make the serverless function
> actually run (previously every route 500'd with `FUNCTION_INVOCATION_FAILED`):
>
> 1. **Static assets bypass the function.** The rewrite `source` uses a negative
>    lookahead — `"/((?!assets/|favicon\\.).*)"` → `/api/index` — so `/assets/*`
>    and `/favicon.*` are served as **static files by Vercel** and never hit the
>    catch-all function. Everything else still rewrites to the function.
> 2. **The seed is bundled + writes fall back to `/tmp`.** `functions."api/index.js".includeFiles`
>    bundles `data/db.json` into the function so the local-JSON backend can **read**
>    the seed. Because Vercel's project filesystem is **read-only**, `store.js`
>    detects Vercel (`process.env.VERCEL`) and, when there are **no Firebase envs**,
>    writes to **`/tmp/db.json`** instead (copy-on-first-write from the bundled seed;
>    reads prefer `/tmp/db.json` if it exists). So a no-Firebase Vercel deploy now
>    **renders all seeded content and no longer crashes** — writes persist within a
>    warm instance and reset on cold start. **With the Firebase envs set, Firestore
>    is used and none of the `/tmp` path runs.** Local `node app.js` is unchanged:
>    it writes to `data/db.json` exactly as before.

```bash
# from poc/
vercel dev        # run the Vercel serverless function locally
vercel            # deploy a preview
vercel --prod     # deploy production
```

Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` and
`ADMIN_PASS` in the Vercel project's Environment Variables.

> **Data persistence:** on Vercel the filesystem is **ephemeral** and the project
> tree is **read-only** — so the JSON backend reads the bundled seed and writes to
> **`/tmp/db.json`** (see v0.5.1 above), which persists only within a warm instance
> and resets on cold start. For durable data **use Firestore** (set the Firebase
> envs). The JSON file backend is for **local dev** (writes to `data/db.json`) and
> as a **no-crash fallback** on Vercel.

The footer-only meta pages (`/updates`, `/ideas`, `/todo`) are backed by a `meta`
object in `db.json` (`{ updates:[], ideas:[], todos:[] }`) and read through
`listUpdates` / `listIdeas` / `listTodos` — so adding an entry is just a `db.json`
edit, no code change.

Chat/social data (`threads` + `messages`) and V1.1 data (`events` + `checkins`,
plus the newbie fields `origination` / `readyForLessons` / `handedToOrganizerId`)
all live in `db.json` too and are only ever touched through these `store.js`
functions. **Organizers are the same inventory as teachers** — one list, two hats
(teach + host). Nothing else touches the JSON.

`app.js` and the pages never touch `db.json` directly — they only call
`store.js`. Swap the store, everything else stays.

## Files

```
poc/
├── app.js        # HTTP server + page templates + routes; exports requestListener
├── tangotiempo.js   # fetchTangoTiempoEvent(idOrUrl) — server-side TangoTiempo pull (v0.6.0, zero deps)
├── eventsLive.js    # v0.8.1 LIVE feed: getLiveEvents() — fetch beginnerFriendly SUPERSET (both flags kept) + RRULE-expand (rrule) + 15-min cache + fallback
├── store.js         # the ONLY data layer — env-gated Firestore / local-JSON (async)
├── api/index.js     # Vercel serverless entrypoint (delegates to requestListener)
├── vercel.json      # Vercel rewrite → /api/index (assets/favicon excluded) + includeFiles seed
├── package.json     # v0.8.1; firebase-admin + rrule dependencies
├── data/db.json     # local JSON store (9 organizers + 9 lesson studios + 4 real TangoTiempo events w/ shortName/org/date/venue/icon + beginnerFriendly:true + meta; empty newbies/volunteers/messages/checkins)
├── assets/          # hero.png / icon.png slots (+ README)
└── README.md        # this file
```

## Notes / assumptions

- **Admin gate (v0.4.0):** `/admin` and its POST routes are gated by `ADMIN_PASS`
  when set (passphrase → cookie); **unset → open** for local dev. Newbie/token
  flows are never gated (no login, by design).
- **Organizers are real (v0.4.0):** 9 real Boston organizers mirroring
  TangoTiempo. Contact fields are intentionally blank for now (a "contact coming
  soon" note shows). Toby Balsley and the unresolved "limeo" entry are **held
  out** per plan.
- **Events are real (v0.6.0):** the 4 seed events hold **real data fetched from
  TangoTiempo** at build time (shortName, organizer, start date, venue, category,
  icon). Each `/events` card deep-links to its TangoTiempo page in a new tab.
  Event `685332` legitimately has **no icon** — the thumbnail is hidden for it.
  Operators add/refresh events from a TangoTiempo link in `/admin`.
- Consent is required on the newbie form (browser + kept on the record).
- Each newbie record now carries a random **`token`** (the no-login device identity);
  the device stores it as `localStorage.tb_token`. Clearing it (or "Not you? Start
  over") sends the device back to the capture form.
- Data persists in `data/db.json` between runs; delete rows there to reset.
