"use strict";
/** The autonomous analysis cycle: collect -> analyze -> verify -> execute.
 *  Runs once per target database, sequentially, every scan interval. */
const { settings } = require("./config");
const { targets } = require("./targets");
const executor = require("./executor");
const { extractColumnsFromFilter, extractPartialPredicate } = require("./planParser");

const log = (t, m) => console.log(`[scheduler] [${t.name}] ${m}`);

async function columnsAlreadyIndexed(target, conn, table, columns) {
  const existing = await target.adapter.getAllIndexesForTable(conn, table);
  return existing.some((idx) => columns.every((col) => (idx.indexdef || "").includes(col)));
}

async function analyzeMissingIndexes(target, conn) {
  const { adapter, store } = target;
  const slow = await adapter.getSlowQueries(conn, 1, 50);
  log(target, `fetched ${slow.length} candidate slow queries (${adapter.engine})`);

  for (const q of slow) {
    const text = String(q.query || "");
    if (!text.trim().toUpperCase().startsWith("SELECT")) continue;

    const { oldCost, findings, safeQuery } = await adapter.analyzeQuery(
      conn, text, settings.minRowsForSeqScanFlag);
    if (!findings.length) continue;

    for (const f of findings) {
      if (!f.table || !f.filter) continue;
      let columns = extractColumnsFromFilter(f.filter);
      let predicate = extractPartialPredicate(f.filter);
      if (predicate && (!columns.length || (columns.length === 1 && columns[0] === predicate.column))) {
        columns = [predicate.column];
        if (!adapter.supportsPartialIndexes) predicate = null;
      } else {
        predicate = null;
      }
      if (!columns.length) continue;
      if (await columnsAlreadyIndexed(target, conn, f.table, columns)) continue;

      const desc = `${f.table}(${columns.join(", ")})` +
        (predicate ? ` WHERE ${predicate.column} ${predicate.op}${predicate.value != null ? " " + predicate.value : ""}` : "");
      try {
        const baseCost = oldCost || f.cost || 1;
        const { improvement, newCost } = await adapter.verifyIndexBenefit(
          conn, safeQuery, f.table, columns, predicate, baseCost);
        if (improvement >= settings.minImprovementPct) {
          const detail = {
            columns, reason: `Full scan on ${f.rows_scanned} rows`,
            estimated_old_cost: baseCost, estimated_new_cost: newCost,
          };
          if (predicate) detail.predicate = predicate;
          store.addRecommendation("missing_index", f.table, detail, improvement);
          log(target, `recommendation: index on ${desc} -> ${improvement}% improvement`);
        }
      } catch (e) {
        console.warn(`[scheduler] [${target.name}] verification failed for ${desc}: ${e.message}`);
      }
    }
  }
}

async function analyzeUnusedIndexes(target, conn) {
  const { adapter, store } = target;
  const raw = await adapter.getUnusedIndexes(conn, target);
  log(target, `found ${raw.length} unused indexes`);
  for (const idx of raw) {
    if (idx.index_name.startsWith(`${settings.indexNamePrefix}_`) &&
        store.ownIndexCreatedWithin(idx.index_name, settings.unusedIndexGraceMinutes)) continue;
    store.addRecommendation("unused_index", idx.table_name, {
      index_name: idx.index_name,
      size_mb: Math.round((idx.size_bytes / 1048576) * 100) / 100,
      scans: idx.idx_scan,
      original_index_definition: (idx.indexdef || "") + ";",
    });
  }
}

async function autoApplyPending(target) {
  const { store } = target;
  for (const rec of store.listRecommendations("pending")) {
    if (rec.type === "missing_index" && !settings.autoCreateIndexes) continue;
    if (rec.type === "unused_index" && !settings.autoDropUnusedIndexes) continue;
    const fp = store.fingerprint(rec.type, rec.table, rec.detail);
    if (store.recentlyActioned(fp, settings.reapplyCooldownMinutes)) {
      store.updateStatus(rec.id, "skipped");
      continue;
    }
    const result = await executor.applyRecommendation(target, rec);
    log(target, `auto-applied rec #${rec.id} -> ${result.status}`);
  }
}

async function runCycleFor(target) {
  const { adapter, store } = target;
  log(target, "starting analysis cycle...");
  let conn;
  try {
    conn = await adapter.connect(target);
    await analyzeMissingIndexes(target, conn);
    await analyzeUnusedIndexes(target, conn);
    try {
      const tables = await adapter.getTableGrowthStats(conn);
      store.recordSizeSnapshot(tables.reduce((s, t) => s + (t.total_size_bytes || 0), 0));
    } catch (e) { console.warn(`[scheduler] [${target.name}] size snapshot failed:`, e.message); }
    if (conn) { adapter.close(conn); conn = null; }
    if (settings.autoCreateIndexes || settings.autoDropUnusedIndexes) await autoApplyPending(target);
    log(target, "analysis cycle completed.");
  } catch (e) {
    console.error(`[scheduler] [${target.name}] cycle failed:`, e.message);
  } finally {
    if (conn) adapter.close(conn);
  }
}

let running = false;
async function runAnalysisCycle() {
  if (running) return;
  running = true;
  try {
    for (const target of targets) await runCycleFor(target);
  } finally {
    running = false;
  }
}

function startScheduler() {
  setInterval(runAnalysisCycle, settings.scanIntervalMinutes * 60e3);
}

module.exports = { runAnalysisCycle, startScheduler };
