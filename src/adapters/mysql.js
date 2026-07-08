"use strict";
/** MySQL 8 adapter: performance_schema + EXPLAIN FORMAT=JSON + INVISIBLE
 *  index verification. FK-required and FULLTEXT indexes are protected. */
const mysql = require("mysql2/promise");
const { calcImprovementPct } = require("../planParser");

const engine = "mysql";
const supportsPartialIndexes = false;

const connect = (target) => mysql.createConnection({
  host: target.host, port: target.port, database: target.database,
  user: target.user, password: target.password,
});
const close = (c) => c.end().catch(() => {});
const ping = async (c) => { await c.query("SELECT 1"); };

async function ensurePrerequisites(target) {
  const status = { checked: true, performance_schema: false, actions_needed: [] };
  let c;
  try {
    c = await connect(target);
    const [[row]] = await c.query("SELECT @@performance_schema AS ps");
    if (row.ps === 1) status.performance_schema = true;
    else status.actions_needed.push(
      "performance_schema is OFF. Set performance_schema=ON in my.cnf and restart MySQL.");
  } catch (e) {
    status.actions_needed.push(`Could not connect to the target database: ${e.message}`);
  } finally { if (c) close(c); }
  Object.assign(target.prerequisites, status);
  return status;
}

async function getSlowQueries(c, minCalls = 1, limit = 30) {
  const [rows] = await c.query(`
    SELECT DIGEST AS queryid, DIGEST_TEXT AS query, COUNT_STAR AS calls,
           AVG_TIMER_WAIT / 1e9 AS mean_exec_time, SUM_TIMER_WAIT / 1e9 AS total_exec_time,
           SUM_ROWS_SENT AS \`rows\`
    FROM performance_schema.events_statements_summary_by_digest
    WHERE SCHEMA_NAME = DATABASE() AND COUNT_STAR >= ?
      AND DIGEST_TEXT NOT LIKE 'EXPLAIN%' AND DIGEST_TEXT NOT LIKE 'CREATE%'
      AND DIGEST_TEXT NOT LIKE 'DROP%' AND DIGEST_TEXT NOT LIKE 'ALTER%'
      AND DIGEST_TEXT NOT LIKE 'INSERT%' AND DIGEST_TEXT NOT LIKE 'SET %'
      AND DIGEST_TEXT NOT LIKE '%performance_schema%' AND DIGEST_TEXT NOT LIKE '%information_schema%'
    ORDER BY AVG_TIMER_WAIT DESC LIMIT ?;`, [minCalls, limit]);
  return rows.map(r => ({ ...r, calls: Number(r.calls), mean_exec_time: Number(r.mean_exec_time),
    total_exec_time: Number(r.total_exec_time), rows: Number(r.rows) }));
}

async function getUnusedIndexes(c, target) {
  const [rows] = await c.query(`
    SELECT p.OBJECT_NAME AS table_name, p.INDEX_NAME AS index_name, p.COUNT_STAR AS idx_scan,
           GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX) AS columns_list
    FROM performance_schema.table_io_waits_summary_by_index_usage p
    JOIN information_schema.STATISTICS s
      ON s.TABLE_SCHEMA = p.OBJECT_SCHEMA AND s.TABLE_NAME = p.OBJECT_NAME
     AND s.INDEX_NAME = p.INDEX_NAME
    WHERE p.OBJECT_SCHEMA = DATABASE() AND p.INDEX_NAME IS NOT NULL
      AND p.INDEX_NAME <> 'PRIMARY' AND p.COUNT_STAR = 0 AND s.NON_UNIQUE = 1
      AND s.INDEX_TYPE = 'BTREE'
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS s1
        JOIN information_schema.KEY_COLUMN_USAGE k
          ON k.TABLE_SCHEMA = s1.TABLE_SCHEMA AND k.TABLE_NAME = s1.TABLE_NAME
         AND k.COLUMN_NAME = s1.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL
        WHERE s1.TABLE_SCHEMA = p.OBJECT_SCHEMA AND s1.TABLE_NAME = p.OBJECT_NAME
          AND s1.INDEX_NAME = p.INDEX_NAME AND s1.SEQ_IN_INDEX = 1)
    GROUP BY p.OBJECT_NAME, p.INDEX_NAME, p.COUNT_STAR;`);
  const out = [];
  for (const r of rows) {
    let size = 0;
    try {
      const [[sz]] = await c.query(
        `SELECT stat_value * @@innodb_page_size AS b FROM mysql.innodb_index_stats
         WHERE database_name = DATABASE() AND table_name = ? AND index_name = ? AND stat_name = 'size'`,
        [r.table_name, r.index_name]);
      size = sz ? Number(sz.b) : 0;
    } catch { /* size is cosmetic */ }
    out.push({ schemaname: target.database, table_name: r.table_name, index_name: r.index_name,
      idx_scan: Number(r.idx_scan), size_bytes: size,
      indexdef: `CREATE INDEX ${r.index_name} ON ${r.table_name} (${r.columns_list})` });
  }
  return out;
}

async function getAllIndexesForTable(c, table) {
  const [rows] = await c.query(`
    SELECT INDEX_NAME AS n, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? GROUP BY INDEX_NAME;`, [table]);
  return rows.map(r => ({ indexname: r.n, indexdef: `INDEX ${r.n} ON ${table} (${r.cols})` }));
}

function prettySize(b) {
  for (const u of ["bytes", "kB", "MB", "GB"]) {
    if (b < 1024) return `${Math.round(b)} ${u}`;
    b /= 1024;
  }
  return `${Math.round(b)} TB`;
}

async function getTableGrowthStats(c) {
  const [rows] = await c.query(`
    SELECT TABLE_NAME AS table_name, COALESCE(TABLE_ROWS, 0) AS live_rows,
           COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS total_size_bytes
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY total_size_bytes DESC;`);
  return rows.map(r => ({
    table_name: r.table_name, live_rows: Number(r.live_rows), dead_rows: 0,
    total_size: prettySize(Number(r.total_size_bytes)),
    total_size_bytes: Number(r.total_size_bytes), seq_scan: 0, idx_scan: 0,
  }));
}

const substitute = (q, asString) =>
  q.replace(/\.\.\./g, "?").replace(/\?/g, asString ? "'1'" : "1");

function walkTables(node, out) {
  if (node && typeof node === "object") {
    if (!Array.isArray(node) && node.access_type !== undefined && node.table_name !== undefined) out.push(node);
    for (const v of Object.values(node)) walkTables(v, out);
  }
  return out;
}

async function explainJson(c, safeQuery) {
  const [rows] = await c.query(`EXPLAIN FORMAT=JSON ${safeQuery}`);
  return JSON.parse(rows[0].EXPLAIN);
}

async function analyzeQuery(c, queryText, minRows) {
  for (const asString of [false, true]) {
    const safeQuery = substitute(queryText, asString);
    let explained;
    try { explained = await explainJson(c, safeQuery); } catch { continue; }
    const qb = explained.query_block || {};
    const oldCost = parseFloat(qb.cost_info?.query_cost) || null;
    const findings = [];
    for (const t of walkTables(qb, [])) {
      if (t.access_type !== "ALL") continue;
      const rows = t.rows_examined_per_scan || 0;
      if (rows <= minRows) continue;
      let filter = (t.attached_condition || "").replace(/`/g, "");
      filter = filter.replace(/\b\w+\.(\w+\.)?/g, "");
      findings.push({ table: t.table_name, filter: filter || null, rows_scanned: rows, cost: null });
    }
    return { oldCost, findings, safeQuery };
  }
  return { oldCost: null, findings: [], safeQuery: null };
}

async function verifyIndexBenefit(c, safeQuery, table, columns, predicate, oldCost) {
  const { indexNameFor, validateIdentifier } = require("../executor");
  if (predicate) throw new Error("MySQL does not support partial indexes");
  validateIdentifier(table);
  columns.forEach(validateIdentifier);
  const indexName = indexNameFor(engine, table, columns);
  let created = false;
  try {
    await c.query(`CREATE INDEX ${indexName} ON ${table} (${columns.join(", ")}) INVISIBLE`);
    created = true;
    await c.query("SET SESSION optimizer_switch = 'use_invisible_indexes=on'");
    const plan = await explainJson(c, safeQuery);
    const newCost = parseFloat(plan.query_block?.cost_info?.query_cost) || oldCost;
    return { improvement: calcImprovementPct(oldCost, newCost), newCost };
  } finally {
    await c.query("SET SESSION optimizer_switch = 'use_invisible_indexes=off'").catch(() => {});
    if (created) await c.query(`DROP INDEX ${indexName} ON ${table}`).catch(() => {});
  }
}

module.exports = {
  engine, supportsPartialIndexes,
  connect, close, ping, ensurePrerequisites,
  getSlowQueries, getUnusedIndexes, getAllIndexesForTable, getTableGrowthStats,
  analyzeQuery, verifyIndexBenefit,
};
