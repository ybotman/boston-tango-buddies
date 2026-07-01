# Tango Buddy — POC demo

A **throwaway proof-of-concept** for _Tango Buddy_: a Boston tango newcomer
on-ramp & retention tool. It proves the whole thesis end to end — capture a
**newbie** (with **origination** / how-they-found-us), capture a **volunteer
buddy**, and let an operator **hand-match** them — plus a **Lessons** tab of real
Boston studios, a public **events** listing with **check-in**, and a **studio
handover** that connects the community layer to the lessons layer.

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
> server.js` uses the JSON file. See "Swappable data layer" and "Deploy to
> Vercel" below.

## Run it

Local dev needs only a stock Node.js install (v18+) and **no `npm install`** — the
one dependency (`firebase-admin`) is `require`d lazily and only when the Firebase
envs are set, so the local JSON path never touches it.

```bash
cd poc
node server.js
```

Then open **http://localhost:3000**. Stop with `Ctrl-C`.
(Set a different port with `PORT=4000 node server.js`.) The startup log prints the
active store backend (`local JSON` vs `Firestore`).

## Routes

| Route         | What it is                                                              |
|---------------|-------------------------------------------------------------------------|
| `GET /`       | **Token split-landing** (V1.2). **No `tb_token` on the device →** the **newbie capture** form — warm invite. Name, contact, platform, **"How did you find us?" (origination)**, note, required consent. On submit → AJAX `POST /api/newbie` mints a device **token** (saved to `localStorage.tb_token`), a **thank-you** screen shows, then the **with-token home**. **Has `tb_token` →** the **with-token home**: "Welcome back, &lt;name&gt;" + upcoming **Events with one-tap check-in** (token-based, no dropdown) + their check-in history + quiet links to buddy chat & the social feed + a **Bring a buddy** share + "Not you? Start over". |
| `GET /api/me?token=…` | Returns `{ newbie:{id,name,status}, events:[…], checkins:[…] }` for the with-token home. 404 if the token is unknown (client then clears it and shows the form). |
| `GET /manifest.webmanifest` | PWA **add-to-home-screen** manifest (name "Boston Tango Buddies", short_name "Tango Buddies", `display:standalone`, warm theme/background, `start_url:"/"`, icons → `/assets/icon.png`). `application/manifest+json`. |
| `GET /volunteer` | **Volunteer (buddy) capture** — the other side. Name, contact, Boston area, availability, note. → `POST /api/volunteer` |
| `GET /events`    | **Events** — public "what's happening near you" listing. **v0.4.0:** 4 **real** Boston events that each **deep-link out to their TangoTiempo event page** (each card's "View on TangoTiempo →" opens in a new tab; marked "via TangoTiempo"). **No login check-in** stays available (`POST /api/checkin`). |
| `GET /lessons`  | **Lessons tab (v0.5.0)** — the 9 **real** Boston teaching studios (Alla Tango, Blue Tango, Foundry/Roger Wood, Queer Tango Boston, Tango Academy of Boston, Tango Affair, Tango Society of Boston, Tango Spark, Ultimate Tango) as mobile cards. Each card: studio name + a **Call** button (`tel:`, only if a phone exists) + a **Website** button (opens in a new tab, only if a web exists). Warm, money-free intro. This is the **studios/teachers** collection — SEPARATE from the event **organizers**. The newbie "I want lessons" intent (with-token home) links here. |
| `GET /teachers`  | **302-redirects to `/lessons`** (v0.5.0). Organizers are no longer a public browse page — they live on events and stay manageable in `/admin`. |
| `GET /more`      | **v0.4.0 — More.** Two warm outbound links (open in a new tab): **Boston Tango Calendar** (bostontangocalendar.com) and **TangoTiempo** (tangotiempo.com, national). Linked from the **footer**. Money-free. |
| `GET /admin`     | **Operator dashboard** — tables of newbies + volunteers, per-newbie **match** control (→ `POST /api/match`), **origination** column, per-newbie **check-in history** (the retention signal), **"Ready for lessons"** toggle (→ `POST /api/ready`) + **handover to an organizer** (→ `POST /api/handover`), plus **manage events** (add → `POST /api/event`, edit → `POST /api/event/update`) and — as **two clearly separate sections** (v0.5.0) — **Organizers (events)** (add → `POST /api/organizer`, edit → `POST /api/organizer/update`) and **Studios / Teachers (lessons)** (add → `POST /api/studio`, edit → `POST /api/studio/update`), and current pairings. **v0.4.0 — passphrase gate:** when `ADMIN_PASS` is set, `/admin` (+ its POST routes) require the passphrase (via `?pass=…` → cookie); unset (local dev) → open. |
| `GET /chat`      | **Buddy ↔ Newbie chat** — private 1:1 thread for a matched pairing. **No login:** a "view as" switch lets you pick a pairing and speak as either the newbie or the buddy. Polls `GET /api/thread?id=…` every ~3s. Posts → `POST /api/chat`. Empty state points you to `/admin` to make a match first. |
| `GET /social`    | **Rolling Newbies** — one open group feed the whole newbie cohort shares. Pick or free-type a "posting as" name and post. Same ~3s poll. Posts → `POST /api/social`. |
| `GET /coming`    | **What's Coming** — enticing "coming soon" cards (Buddy Card, Community chat, and preview cards). The **Buddy Card stays preview-only here.** **Features & ideas only — no money language anywhere** (no pricing/payments/revenue/$). |
| `GET /updates`   | **Updates — "What we've added"** — the release story, newest first (v0.2.0 → v0.0.x). **Footer-only page** (not in the top menu). Data-driven from `store.listUpdates()`. |
| `GET /ideas`     | **Ideas — "What's possible"** — where we collect ideas/possibilities for where Tango Buddy could go (Buddy Card, community network, rolling lifecycle, organizer↔community chat, multi-city, deeper TangoTiempo link). **Features/ideas only — no money language.** **Footer-only page.** Data-driven from `store.listIdeas()`. |
| `GET /todo`      | **To-do — "Upcoming (approved)"** — the next agreed things to build (token device-landing, real organizers, rolling lifecycle demo). **Footer-only page.** Data-driven from `store.listTodos()`. |
| `GET /api/thread?id=…` | Returns `{ id, messages: [...] }` (oldest-first) for the chat/social pollers. |
| `POST /api/newbie` | Creates a newbie **and mints a device `token`**. AJAX callers (`Accept: application/json`) get `{ token }`; a plain no-JS POST redirects to `/?flash=thanks`. |
| `POST /api/checkin` | Check-in. Accepts **either** `newbieId` (the `/events` dropdown) **or** `token` (the with-token home's one-tap). JSON callers get `{ ok:true }`; plain posts redirect to `/events?flash=checkedin`. |
| `GET /assets/*`  | Static files if present (`hero.png`, `icon.png`, …) — 404s gracefully if missing. |

### No login — demo "view as" switch

There is **no auth anywhere** (by design — this is a local demo Toby clicks around).
Chat identity is a demo **"view as" selector**: on `/chat` you choose a matched
pairing and toggle whether you're speaking as the **newbie** or the **buddy**, then
send. On `/social` you just type (or pick) a "posting as" name. **Event check-in** on
`/events` is the same idea — pick your name from a dropdown, no login. Messages and
check-ins persist in `db.json` via `store.js` and appear live where relevant.
Code comments in `server.js` mark exactly where an operator login would gate the
`/admin`-driven POST endpoints (events, organizers, ready, handover) in production.

### "What's Coming" is features/ideas only — no money

The `/coming` page describes future features purely as **experiences** ("one card,
tango across the city"). It intentionally contains **no money language** — no pricing,
payments, payouts, revenue, cost, fees, or "$" — anywhere on the page or in the app.

### Footer (the primary nav) + version

Every page renders one **shared footer** (mobile-first, ~44px+ tap targets, wraps
cleanly on a narrow phone):

- **Primary actions:** **Be a buddy** (→ `/volunteer`) · **Admin** (→ `/admin`)
- **Meta line:** **Tango Buddy v0.5.0** · **Lessons** (→ `/lessons`) · **More**
  (→ `/more`) · **Updates** (→ `/updates`) · **Ideas** (→ `/ideas`) · **To-do**
  (→ `/todo`)

The footer's meta links are the **only** way to reach the three meta pages — they
are deliberately **not in the top menu**. The version string is read once from
`package.json` at startup (`require('./package.json').version`) — **no dependency**,
one semver source of truth (bump `package.json` → footer updates).

### Token device-landing — the light, no-login identity (V1.2)

There is still **no login**. Instead, `POST /api/newbie` mints a random **device
token**; the client saves it to `localStorage` as **`tb_token`**. On every `/` load a
tiny vanilla-JS script decides which of three regions to show inside the one URL:

1. **No token → the 1× capture form** (server-rendered, visible by default — works
   even with JS off via a plain form POST + a `?flash=thanks` card).
2. **Fresh sign-up → a warm thank-you** ("You're in! …keep this on your phone…"),
   then a tap into the home.
3. **Has token → the with-token home** — fetches `GET /api/me?token=…` and renders
   "Welcome back, &lt;name&gt;", upcoming **Events with one-tap check-in** (posts the
   token, no dropdown), the newbie's **check-in history**, quiet links to their
   **buddy chat** + the **social feed**, and a **Bring a buddy** share. A **"Not you?
   Start over"** link clears `tb_token`.

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
surface works for both backends; `server.js` `await`s them. The surface is
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

With **no** env vars set, `node server.js` runs the local JSON store with admin
open — the zero-config local experience.

## Deploy to Vercel

`vercel.json` rewrites **all** requests to a single serverless function
(`api/index.js`) that delegates to the exact same `requestListener` exported from
`server.js` — so the app behaves identically locally (`node server.js`) and on
Vercel. `firebase-admin` is a declared dependency (installed on Vercel; only
imported when the Firebase envs are present).

```bash
# from poc/
vercel dev        # run the Vercel serverless function locally
vercel            # deploy a preview
vercel --prod     # deploy production
```

Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` and
`ADMIN_PASS` in the Vercel project's Environment Variables.

> **Data persistence:** on Vercel the filesystem is **ephemeral** — writes to
> `data/db.json` do **not** persist across invocations / cold starts. **On Vercel
> you must use Firestore** (set the Firebase envs). The JSON file backend is for
> **local dev only**. Without the Firebase envs a Vercel deploy still serves, but
> only reads the bundled seed `db.json` (writes are lost).

The footer-only meta pages (`/updates`, `/ideas`, `/todo`) are backed by a `meta`
object in `db.json` (`{ updates:[], ideas:[], todos:[] }`) and read through
`listUpdates` / `listIdeas` / `listTodos` — so adding an entry is just a `db.json`
edit, no code change.

Chat/social data (`threads` + `messages`) and V1.1 data (`events` + `checkins`,
plus the newbie fields `origination` / `readyForLessons` / `handedToOrganizerId`)
all live in `db.json` too and are only ever touched through these `store.js`
functions. **Organizers are the same inventory as teachers** — one list, two hats
(teach + host). Nothing else touches the JSON.

`server.js` and the pages never touch `db.json` directly — they only call
`store.js`. Swap the store, everything else stays.

## Files

```
poc/
├── server.js        # HTTP server + page templates + routes; exports requestListener
├── store.js         # the ONLY data layer — env-gated Firestore / local-JSON (async)
├── api/index.js     # Vercel serverless entrypoint (delegates to requestListener)
├── vercel.json      # Vercel catch-all rewrite → /api/index
├── package.json     # v0.5.0; firebase-admin dependency (used only when envs present)
├── data/db.json     # local JSON store (9 organizers + 9 lesson studios + 4 TangoTiempo events + meta; empty newbies/volunteers/messages/checkins)
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
- **Events are real (v0.4.0):** 4 events that deep-link out to their TangoTiempo
  event pages (titles/dates TBD; each opens on TangoTiempo in a new tab).
- Consent is required on the newbie form (browser + kept on the record).
- Each newbie record now carries a random **`token`** (the no-login device identity);
  the device stores it as `localStorage.tb_token`. Clearing it (or "Not you? Start
  over") sends the device back to the capture form.
- Data persists in `data/db.json` between runs; delete rows there to reset.
