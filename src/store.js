"use strict";
/**
 * SQLite-backed recommendations + action history (better-sqlite3, sync).
 * One state file serves all target databases: every row is tagged with its
 * target (engine://host:port/db) and storeFor(target) returns an API whose
 * every query is scoped to that target, so a recommendation recorded for one
 * database can never be executed against another.
 */
const Database = require("better-sqlite3");
const { settings } = require("./config");

const db = new Database(settings.stateDbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    table_name TEXT NOT NULL,
    detail TEXT NOT NULL,
    improvement_pct REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    applied_at TEXT,
    executed_sql TEXT,
    rollback_sql TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recs_target_fp ON recommendations (target, fingerprint);
  CREATE TABLE IF NOT EXISTS size_snapshots (
    target TEXT NOT NULL, taken_at TEXT NOT NULL, total_bytes INTEGER NOT NULL
  );
`);
// retention: prune resolved history; pending is never pruned
const cutoff = new Date(Date.now() - settings.historyRetentionDays * 86400e3).toISOString();
db.prepare("DELETE FROM recommendations WHERE status != 'pending' AND created_at < ?").run(cutoff);

const now = () => new Date().toISOString();
const rowToRec = (r) => r && {
  id: r.id, type: r.type, table: r.table_name, detail: JSON.parse(r.detail),
  improvement_pct: r.improvement_pct, status: r.status, created_at: r.created_at,
  applied_at: r.applied_at, executed_sql: r.executed_sql,
  rollback_sql: r.rollback_sql, error: r.error,
};

function fingerprint(type, table, detail) {
  if (type === "missing_index") {
    const cols = [...(detail.columns || [])].sort().join(",");
    const p = detail.predicate;
    const pp = p ? `:${p.column} ${p.op}${p.value != null ? " " + p.value : ""}` : "";
    return `${type}:${table}:${cols}${pp}`;
  }
  if (type === "unused_index") return `${type}:${table}:${detail.index_name}`;
  return `${type}:${table}:${JSON.stringify(detail)}`;
}

/** All read/write operations for one target database. */
function storeFor(cfg) {
  const target = `${cfg.dbEngine}://${cfg.host}:${cfg.port}/${cfg.database}`;

  function getRecommendation(id) {
    return rowToRec(db.prepare("SELECT * FROM recommendations WHERE id=? AND target=?").get(id, target));
  }

  function addRecommendation(type, table, detail, improvementPct = null) {
    const fp = fingerprint(type, table, detail);
    const existing = db.prepare(
      "SELECT * FROM recommendations WHERE target=? AND fingerprint=? AND status='pending'"
    ).get(target, fp);
    if (existing) return rowToRec(existing);
    const info = db.prepare(
      `INSERT INTO recommendations (target,type,table_name,detail,improvement_pct,status,fingerprint,created_at)
       VALUES (?,?,?,?,?,'pending',?,?)`
    ).run(target, type, table, JSON.stringify(detail), improvementPct, fp, now());
    return getRecommendation(info.lastInsertRowid);
  }

  function listRecommendations(status = null) {
    const rows = status
      ? db.prepare("SELECT * FROM recommendations WHERE target=? AND status=? ORDER BY created_at DESC").all(target, status)
      : db.prepare("SELECT * FROM recommendations WHERE target=? ORDER BY created_at DESC").all(target);
    return rows.map(rowToRec);
  }

  function updateStatus(id, status) {
    db.prepare("UPDATE recommendations SET status=? WHERE id=? AND target=?").run(status, id, target);
    return getRecommendation(id);
  }
  function updateDetail(id, detail) {
    db.prepare("UPDATE recommendations SET detail=? WHERE id=? AND target=?")
      .run(JSON.stringify(detail), id, target);
  }
  function markApplied(id, executedSql, rollbackSql) {
    db.prepare(`UPDATE recommendations SET status='applied', applied_at=?, executed_sql=?,
                rollback_sql=?, error=NULL WHERE id=? AND target=?`)
      .run(now(), executedSql, rollbackSql, id, target);
    return getRecommendation(id);
  }
  function markFailed(id, error) {
    db.prepare("UPDATE recommendations SET status='failed', error=? WHERE id=? AND target=?")
      .run(String(error), id, target);
    return getRecommendation(id);
  }

  function recentlyActioned(fp, withinMinutes) {
    const cut = new Date(Date.now() - withinMinutes * 60e3).toISOString();
    return !!db.prepare(
      `SELECT 1 FROM recommendations WHERE target=? AND fingerprint=? AND status IN ('applied','failed')
       AND COALESCE(applied_at, created_at) >= ? LIMIT 1`
    ).get(target, fp, cut);
  }

  function ownIndexCreatedWithin(indexName, withinMinutes) {
    const cut = new Date(Date.now() - withinMinutes * 60e3).toISOString();
    return !!db.prepare(
      `SELECT 1 FROM recommendations WHERE target=? AND type='missing_index' AND status='applied'
       AND applied_at >= ? AND detail LIKE ? LIMIT 1`
    ).get(target, cut, `%"index_name":"${indexName}"%`);
  }

  const listActions = (limit = 50) =>
    db.prepare(
      `SELECT * FROM recommendations WHERE target=? AND status IN ('applied','failed','rolled_back')
       ORDER BY COALESCE(applied_at, created_at) DESC LIMIT ?`
    ).all(target, limit).map(rowToRec);

  function recordSizeSnapshot(totalBytes) {
    db.prepare("INSERT INTO size_snapshots (target, taken_at, total_bytes) VALUES (?,?,?)")
      .run(target, now(), totalBytes);
    const cut = new Date(Date.now() - 30 * 86400e3).toISOString();
    db.prepare("DELETE FROM size_snapshots WHERE target=? AND taken_at < ?").run(target, cut);
  }

  function sizeGrowthPerDay() {
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    const rows = db.prepare(
      "SELECT taken_at, total_bytes FROM size_snapshots WHERE target=? AND taken_at >= ? ORDER BY taken_at"
    ).all(target, since);
    if (rows.length < 2) return null;
    const hours = (new Date(rows.at(-1).taken_at) - new Date(rows[0].taken_at)) / 3600e3;
    if (hours < 2) return null;
    return (rows.at(-1).total_bytes - rows[0].total_bytes) / (hours / 24);
  }

  return {
    fingerprint, addRecommendation, listRecommendations, getRecommendation,
    updateStatus, updateDetail, markApplied, markFailed,
    recentlyActioned, ownIndexCreatedWithin, listActions,
    recordSizeSnapshot, sizeGrowthPerDay,
  };
}

module.exports = { fingerprint, storeFor };
