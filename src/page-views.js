'use strict';

// „Ko je pogledao“: bilježi samo DA je neko otvorio sedmični raspored ili mjesečne iznose –
// koju sedmicu (ponedjeljak) odn. mjesec, za kojeg igrača, ko (član, dječiji ili roditeljski račun) i kada.
// Po igraču i osobi čuva se samo posljednje otvaranje. Zapisi stariji od 3 mjeseca se brišu automatski.
const KINDS = ['raspored', 'iznosi'];
const VIEWER_TYPES = ['clan', 'dijete', 'roditelj'];
const KEEP_MONTHS = 3;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const lastCleanup = new WeakMap();

function cutoffISO(now = Date.now()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - KEEP_MONTHS);
  return d.toISOString();
}

function cleanupViews(db, now = Date.now()) {
  db.prepare('DELETE FROM page_views WHERE at < ?').run(cutoffISO(now));
  lastCleanup.set(db, now);
}

// playerIds: igrači čiji su podaci bili prikazani (bez duplikata).
function recordView(db, { kind, period, playerIds, viewerType, viewerId }) {
  if (!KINDS.includes(kind) || !VIEWER_TYPES.includes(viewerType)) return;
  const ids = [...new Set(playerIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return;
  const now = Date.now();
  const at = new Date(now).toISOString();
  const upsert = db.prepare(
    `INSERT INTO page_views (kind, period, player_id, viewer_type, viewer_id, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, period, player_id, viewer_type, viewer_id) DO UPDATE SET at = excluded.at`
  );
  for (const id of ids) upsert.run(kind, period, id, viewerType, viewerId, at);
  const last = lastCleanup.get(db);
  if (last === undefined || now - last >= CLEANUP_EVERY_MS || now < last) cleanupViews(db, now);
}

// Sva otvaranja po igraču (svaki račun sa svojim posljednjim otvaranjem, najnovije prvo):
// Map(player_id → [{ at, viewer_type, viewer_id, viewer_name }, …]).
function viewsByPlayer(db, kind, period) {
  const map = new Map();
  for (const r of [...latestViews.rows(db, kind, period)].reverse()) {
    if (!map.has(r.player_id)) map.set(r.player_id, []);
    map.get(r.player_id).push(r);
  }
  return map;
}

// Posljednje otvaranje po roditeljskom računu: Map(parent_account_id → at).
function parentViews(db, kind, period) {
  const rows = db.prepare(
    "SELECT viewer_id, MAX(at) AS at FROM page_views WHERE kind = ? AND period = ? AND viewer_type = 'roditelj' GROUP BY viewer_id"
  ).all(kind, period);
  return new Map(rows.map((r) => [r.viewer_id, r.at]));
}

// Posljednje otvaranje po igraču: Map(player_id → { at, viewer_type, viewer_id, viewer_name }).
function latestViews(db, kind, period) {
  const rows = latestViews.rows(db, kind, period);
  const map = new Map();
  for (const r of rows) map.set(r.player_id, r);
  return map;
}

latestViews.rows = (db, kind, period) => db.prepare(
  `SELECT v.*, CASE v.viewer_type WHEN 'roditelj' THEN pa.name ELSE u.name END AS viewer_name
     FROM page_views v
     LEFT JOIN users u ON v.viewer_type IN ('clan', 'dijete') AND u.id = v.viewer_id
     LEFT JOIN parent_accounts pa ON v.viewer_type = 'roditelj' AND pa.id = v.viewer_id
    WHERE v.kind = ? AND v.period = ?
    ORDER BY v.at, v.id`
).all(kind, period);

module.exports = { recordView, cleanupViews, latestViews, viewsByPlayer, parentViews, KEEP_MONTHS };
