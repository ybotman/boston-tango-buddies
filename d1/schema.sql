-- =============================================================================
-- schema.sql — Tango Buddies D1 (btb-prod) — Phase A
-- =============================================================================
-- Generic doc store + per-collection views.
--
-- WHY generic: store.js's ~25 public functions all sit on a 4-method backend
-- surface (all/get/set/meta). One (collection,id,json) table serves every
-- collection unchanged, so adding D1 required NO change to the public API.
--
-- WHY views: the raw table is JSON blobs and is miserable to read by hand.
-- These views make each collection read like a normal SQL table in the D1
-- dashboard console, `wrangler d1 execute`, and .sql exports. That hand-
-- queryability is the stated reason D1 was chosen over the alternatives.
--
-- Apply (account id is deliberately NOT hard-coded here — this repo is public;
-- the current value lives in state/PHASE-A-STATUS.md and in the Vercel env):
--   CLOUDFLARE_ACCOUNT_ID=<cf-account-id> \
--   wrangler d1 execute btb-prod --remote --file=d1/schema.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  json       TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection);

-- --- views ------------------------------------------------------------------
-- Field lists follow store.js's "Data shapes" header comment. Booleans surface
-- as SQLite 0/1. Dropped and recreated so re-running this file is idempotent
-- even when a projection changes.

DROP VIEW IF EXISTS newbies;
CREATE VIEW newbies AS
SELECT id,
       json_extract(json,'$.name')                AS name,
       json_extract(json,'$.contact')             AS contact,
       json_extract(json,'$.platform')            AS platform,
       json_extract(json,'$.note')                AS note,
       json_extract(json,'$.consent')             AS consent,
       json_extract(json,'$.status')              AS status,
       json_extract(json,'$.buddyId')             AS buddyId,
       json_extract(json,'$.createdAt')           AS createdAt,
       json_extract(json,'$.origination')         AS origination,
       json_extract(json,'$.readyForLessons')     AS readyForLessons,
       json_extract(json,'$.handedToOrganizerId') AS handedToOrganizerId,
       -- V1.1.0 signup fields. NULL means NOT ASKED, which is NOT the same as
       -- "no": the 7 backfilled historical newcomers were never asked these
       -- questions. Filter with `wantsBuddy = 1` / `= 0` / `IS NULL` accordingly
       -- — do not treat NULL as false.
       json_extract(json,'$.firstName')           AS firstName,
       json_extract(json,'$.lastName')            AS lastName,
       json_extract(json,'$.contact2')            AS contact2,
       json_extract(json,'$.platform2')           AS platform2,
       json_extract(json,'$.wantsBuddy')          AS wantsBuddy,
       json_extract(json,'$.dancedBefore')        AS dancedBefore,
       json_extract(json,'$.dancedWhat')          AS dancedWhat,
       json_extract(json,'$.dancedTangoBefore')   AS dancedTangoBefore
FROM docs WHERE collection='newbies';

DROP VIEW IF EXISTS volunteers;
CREATE VIEW volunteers AS
SELECT id,
       json_extract(json,'$.name')         AS name,
       json_extract(json,'$.contact')      AS contact,
       json_extract(json,'$.area')         AS area,
       json_extract(json,'$.availability') AS availability,
       json_extract(json,'$.note')         AS note,
       json_extract(json,'$.createdAt')    AS createdAt
FROM docs WHERE collection='volunteers';

DROP VIEW IF EXISTS organizers;
CREATE VIEW organizers AS
SELECT id,
       json_extract(json,'$.name')     AS name,
       json_extract(json,'$.studio')   AS studio,
       json_extract(json,'$.code')     AS code,
       json_extract(json,'$.blurb')    AS blurb,
       json_extract(json,'$.email')    AS email,
       json_extract(json,'$.phone')    AS phone,
       json_extract(json,'$.whatsapp') AS whatsapp,
       json_extract(json,'$.web')      AS web,
       json_extract(json,'$.demo')     AS demo
FROM docs WHERE collection='organizers';

DROP VIEW IF EXISTS studios;
CREATE VIEW studios AS
SELECT id,
       json_extract(json,'$.name')      AS name,
       json_extract(json,'$.phone')     AS phone,
       json_extract(json,'$.web')       AS web,
       json_extract(json,'$.createdAt') AS createdAt
FROM docs WHERE collection='studios';

DROP VIEW IF EXISTS threads;
CREATE VIEW threads AS
SELECT id,
       json_extract(json,'$.kind')      AS kind,
       json_extract(json,'$.newbieId')  AS newbieId,
       json_extract(json,'$.createdAt') AS createdAt
FROM docs WHERE collection='threads';

DROP VIEW IF EXISTS messages;
CREATE VIEW messages AS
SELECT id,
       json_extract(json,'$.threadId')  AS threadId,
       json_extract(json,'$.fromName')  AS fromName,
       json_extract(json,'$.body')      AS body,
       json_extract(json,'$.createdAt') AS createdAt
FROM docs WHERE collection='messages';

DROP VIEW IF EXISTS checkins;
CREATE VIEW checkins AS
SELECT id,
       json_extract(json,'$.newbieId')   AS newbieId,
       json_extract(json,'$.eventId')    AS eventId,
       json_extract(json,'$.status')     AS status,
       json_extract(json,'$.when')       AS "when",
       json_extract(json,'$.updatedAt')  AS updatedAt,
       -- Event snapshot taken AT CHECK-IN TIME. Events come from a rolling
       -- 2-week live feed, so these are the only durable record of what the
       -- person actually attended. NULL on rows written before the snapshot existed.
       json_extract(json,'$.eventTitle') AS eventTitle,
       json_extract(json,'$.eventDate')  AS eventDate,
       json_extract(json,'$.eventOrg')   AS eventOrg,
       json_extract(json,'$.eventUrl')   AS eventUrl
FROM docs WHERE collection='checkins';

DROP VIEW IF EXISTS events;
CREATE VIEW events AS
SELECT id,
       json_extract(json,'$.ttId')             AS ttId,
       json_extract(json,'$.shortName')        AS shortName,
       json_extract(json,'$.orgName')          AS orgName,
       json_extract(json,'$.startDate')        AS startDate,
       json_extract(json,'$.venueName')        AS venueName,
       json_extract(json,'$.category')         AS category,
       json_extract(json,'$.beginnerFriendly') AS beginnerFriendly,
       json_extract(json,'$.title')            AS title,
       json_extract(json,'$.date')             AS date,
       json_extract(json,'$.time')             AS time,
       json_extract(json,'$.location')         AS location,
       json_extract(json,'$.organizerId')      AS organizerId,
       json_extract(json,'$.url')              AS url,
       json_extract(json,'$.link')             AS link,
       json_extract(json,'$.source')           AS source,
       json_extract(json,'$.demo')             AS demo,
       json_extract(json,'$.createdAt')        AS createdAt
FROM docs WHERE collection='events';
