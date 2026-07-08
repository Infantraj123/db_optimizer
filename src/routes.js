"use strict";
const express = require("express");
const { settings } = require("./config");
const { targets } = require("./targets");
const executor = require("./executor");

const router = express.Router();

/** run fn with a fresh connection to the request's target, always closed */
async function withConn(target, fn) {
  const conn = await target.adapter.connect(target);
  try { return await fn(conn); } finally { target.adapter.close(conn); }
}
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ detail: e.message }));

const sqlPreview = (target, rec) => {
  try { return executor.buildSqlForRecommendation(target, rec); }
  catch (e) { return { error: e.message }; }
};

const targetSummary = (t) => ({
  name: t.name, engine: t.dbEngine, host: t.host, port: t.port, database: t.database,
  prerequisites: t.prerequisites,
});

/* ------------------------------- targets ------------------------------ */
router.get("/targets", wrap(async (req, res) => res.json(targets.map(targetSummary))));

/* ------------------------------- health ------------------------------- */
router.get("/health", wrap(async (req, res) => {
  const t = req.target;
  try {
    await withConn(t, (c) => t.adapter.ping(c));
    const needed = (t.prerequisites.actions_needed || []).length;
    res.json({ status: needed ? "degraded" : "ok", db_connection: "ok",
               engine: t.dbEngine, database: t.name, prerequisites: t.prerequisites });
  } catch (e) {
    res.json({ status: "degraded", db_connection: "failed",
               engine: t.dbEngine, database: t.name, error: e.message });
  }
}));

/* ------------------------------- queries ------------------------------ */
router.get("/queries/slow", wrap(async (req, res) => {
  const rows = await withConn(req.target, (c) =>
    req.target.adapter.getSlowQueries(c, parseInt(req.query.min_calls || "1", 10),
                                         parseInt(req.query.limit || "30", 10)));
  res.json(rows);
}));

/* ------------------------------- tables ------------------------------- */
const fmtUnused = (raw) => raw.map((r) => ({
  table: r.table_name, index: r.index_name, scans: r.idx_scan,
  size_mb: Math.round((r.size_bytes / 1048576) * 100) / 100, indexdef: r.indexdef,
}));

router.get("/tables/unused-indexes", wrap(async (req, res) =>
  res.json(fmtUnused(await withConn(req.target, (c) => req.target.adapter.getUnusedIndexes(c, req.target))))));
router.get("/tables/growth", wrap(async (req, res) =>
  res.json(await withConn(req.target, (c) => req.target.adapter.getTableGrowthStats(c)))));

/* --------------------------- recommendations -------------------------- */
router.get("/recommendations", wrap(async (req, res) => {
  let recs = req.target.store.listRecommendations(req.query.status || null);
  if (req.query.type) recs = recs.filter((r) => r.type === req.query.type);
  res.json(recs.map((r) => ({ ...r, sql: sqlPreview(req.target, r) })));
}));

router.get("/recommendations/:id(\\d+)/sql", wrap(async (req, res) => {
  const rec = req.target.store.getRecommendation(+req.params.id);
  if (!rec) return res.status(404).json({ detail: "Recommendation not found" });
  res.json(sqlPreview(req.target, rec));
}));

router.get("/recommendations/:id(\\d+)", wrap(async (req, res) => {
  const rec = req.target.store.getRecommendation(+req.params.id);
  if (!rec) return res.status(404).json({ detail: "Recommendation not found" });
  res.json({ ...rec, sql: sqlPreview(req.target, rec) });
}));

router.post("/recommendations/:id(\\d+)/apply", wrap(async (req, res) => {
  const rec = req.target.store.getRecommendation(+req.params.id);
  if (!rec) return res.status(404).json({ detail: "Recommendation not found" });
  if (!["pending", "failed", "skipped"].includes(rec.status)) {
    return res.status(409).json({ detail: `Recommendation is already '${rec.status}'` });
  }
  const result = await executor.applyRecommendation(req.target, rec);
  if (result.status === "failed") return res.status(500).json({ detail: `Apply failed: ${result.error}` });
  res.json(result);
}));

router.post("/recommendations/:id(\\d+)/rollback", wrap(async (req, res) => {
  const rec = req.target.store.getRecommendation(+req.params.id);
  if (!rec) return res.status(404).json({ detail: "Recommendation not found" });
  try { res.json(await executor.rollbackRecommendation(req.target, rec)); }
  catch (e) { res.status(409).json({ detail: e.message }); }
}));

for (const [action, status] of [["acknowledge", "acknowledged"], ["reject", "rejected"], ["reopen", "pending"]]) {
  router.post(`/recommendations/:id(\\d+)/${action}`, wrap(async (req, res) => {
    const rec = req.target.store.updateStatus(+req.params.id, status);
    if (!rec) return res.status(404).json({ detail: "Recommendation not found" });
    res.json(rec);
  }));
}

/* ------------------------------ analytics ----------------------------- */
router.get("/analytics/config", wrap(async (req, res) => res.json({
  engine: req.target.dbEngine, database: req.target.database, target: req.target.name,
  databases: targets.map((t) => t.name),
  scan_interval_minutes: settings.scanIntervalMinutes,
  auto_create_indexes: settings.autoCreateIndexes,
  auto_drop_unused_indexes: settings.autoDropUnusedIndexes,
  min_improvement_pct: settings.minImprovementPct,
  min_rows_for_flag: settings.minRowsForSeqScanFlag,
  index_name_prefix: settings.indexNamePrefix,
})));

router.get("/analytics/actions", wrap(async (req, res) =>
  res.json(req.target.store.listActions(parseInt(req.query.limit || "50", 10)))));

router.get("/analytics/overview", wrap(async (req, res) => {
  const t = req.target;
  const all = t.store.listRecommendations();
  const pending = all.filter((r) => r.status === "pending");
  const byStatus = {};
  for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const wasted = pending.filter((r) => r.type === "unused_index")
    .reduce((s, r) => s + (r.detail.size_mb || 0), 0);
  const [slow, growth] = await withConn(t, async (c) => [
    await t.adapter.getSlowQueries(c, 1, 1), await t.adapter.getTableGrowthStats(c)]);
  res.json({
    pending_missing_index_count: pending.filter((r) => r.type === "missing_index").length,
    pending_unused_index_count: pending.filter((r) => r.type === "unused_index").length,
    total_recommendations_by_status: byStatus,
    total_wasted_index_storage_mb: Math.round(wasted * 100) / 100,
    slowest_query_right_now: slow[0] || null,
    biggest_tables: growth.slice(0, 5),
  });
}));

router.get("/analytics/tables/top-by-size", wrap(async (req, res) => {
  const stats = await withConn(req.target, (c) => req.target.adapter.getTableGrowthStats(c));
  res.json(stats.slice(0, parseInt(req.query.limit || "10", 10)));
}));
router.get("/analytics/queries/top-slow", wrap(async (req, res) =>
  res.json(await withConn(req.target, (c) =>
    req.target.adapter.getSlowQueries(c, 1, parseInt(req.query.limit || "10", 10))))));

router.get("/analytics/wasted-storage", wrap(async (req, res) => {
  const unused = req.target.store.listRecommendations("pending").filter((r) => r.type === "unused_index");
  res.json({
    unused_index_count: unused.length,
    total_reclaimable_mb: Math.round(unused.reduce((s, r) => s + (r.detail.size_mb || 0), 0) * 100) / 100,
    indexes: unused.map((r) => ({ table: r.table, index: r.detail.index_name, size_mb: r.detail.size_mb })),
  });
}));

module.exports = { router, withConn, wrap };
