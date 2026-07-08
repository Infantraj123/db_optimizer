"use strict";
/** PostgreSQL adapter: pg_stat_statements + EXPLAIN ANALYZE + HypoPG. */
const { Client } = require("pg");
const { calcImprovementPct } = require("../planParser");

const engine = "postgres";
const supportsPartialIndexes = true;

async function connect(target) {
  const c = new Client({
    host: target.host, port: target.port, database: target.database,
    user: target.user, password: target.password,
  });
  await c.connect();
  return c;
}
const close = (c) => c.end().catch(() => {});
const ping = async (c) => { await c.query("SELECT 1"); };

async function ensurePrerequisites(target) {
  const status = { checked: true, pg_stat_statements: false, hypopg: false, actions_needed: [] };
  let c;
  try {
    c = await connect(target);
    for (const ext of ["pg_stat_statements", "hypopg"]) {
      try { await c.query(`CREATE EXTENSION IF NOT EXISTS ${ext};`); }
      catch (e) {
        const msg = String(e.message).split("\n")[0];
        status.actions_needed.push(
          /is not available|extension control file/.test(msg)
            ? `Extension '${ext}' is not installed on the server. Install the OS package and restart.`
            : `Could not create extension '${ext}': ${msg}`);
      }
    }
    try { await c.query("SELECT count(*) FROM pg_stat_statements;"); status.pg_stat_statements = true; }
    catch { status.actions_needed.push(
      "pg_stat_statements needs preloading: ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'; then restart PostgreSQL."); }
    try { await c.query("SELECT hypopg_reset();"); status.hypopg = true; }
    catch { if (!status.actions_needed.some(a => a.includes("hypopg")))
      status.actions_needed.push("hypopg extension exists but is not functional."); }
  } catch (e) {
    status.actions_needed.push(`Could not connect to the target database: ${e.message}`);
  } finally { if (c) close(c); }
  Object.assign(target.prerequisites, status);
  return status;
}

async function getSlowQueries(c, minCalls = 1, limit = 30) {
  const { rows } = await c.query(`
    SELECT queryid, query, calls, mean_exec_time, total_exec_time, rows
    FROM pg_stat_statements
    WHERE calls >= $1
      AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE 'EXPLAIN%'
      AND query NOT ILIKE 'CREATE%' AND query NOT ILIKE 'DROP%'
      AND query NOT ILIKE 'ALTER%' AND query NOT ILIKE 'INSERT%' AND query NOT ILIKE 'DO %'
    ORDER BY mean_exec_time DESC LIMIT $2;`, [minCalls, limit]);
  return rows;
}

async function getUnusedIndexes(c, target) {
  const { rows } = await c.query(`
    SELECT s.schemaname, s.relname AS table_name, s.indexrelname AS index_name,
           s.idx_scan, pg_relation_size(s.indexrelid) AS size_bytes, pi.indexdef
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON s.indexrelid = i.indexrelid
    JOIN pg_indexes pi ON pi.indexname = s.indexrelname
    WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
    ORDER BY pg_relation_size(s.indexrelid) DESC;`);
  return rows.map(r => ({ ...r, size_bytes: Number(r.size_bytes), idx_scan: Number(r.idx_scan) }));
}

async function getAllIndexesForTable(c, table) {
  const { rows } = await c.query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1;", [table]);
  return rows;
}

async function getTableGrowthStats(c) {
  const { rows } = await c.query(`
    SELECT relname AS table_name, n_live_tup AS live_rows, n_dead_tup AS dead_rows,
           pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
           pg_total_relation_size(relid) AS total_size_bytes,
           seq_scan, COALESCE(idx_scan, 0) AS idx_scan
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;`);
  return rows.map(r => ({ ...r, live_rows: Number(r.live_rows), dead_rows: Number(r.dead_rows),
    total_size_bytes: Number(r.total_size_bytes), seq_scan: Number(r.seq_scan), idx_scan: Number(r.idx_scan) }));
}

const substitute = (q, asString) => q.replace(/\$\d+/g, asString ? "'1'" : "1");

function findSeqScans(node, out, minRows) {
  if (["Seq Scan", "Parallel Seq Scan"].includes(node["Node Type"])) {
    const scanned = (node["Actual Rows"] || 0) + (node["Rows Removed by Filter"] || 0);
    if (scanned > minRows) out.push({
      table: node["Relation Name"], filter: node["Filter"] || null,
      rows_scanned: scanned, cost: node["Total Cost"],
    });
  }
  for (const child of node.Plans || []) findSeqScans(child, out, minRows);
  return out;
}

async function analyzeQuery(c, queryText, minRows) {
  for (const asString of [false, true]) {
    const safeQuery = substitute(queryText, asString);
    try {
      const { rows } = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${safeQuery}`);
      const plan = rows[0]["QUERY PLAN"][0].Plan;
      return { oldCost: plan["Total Cost"], findings: findSeqScans(plan, [], minRows), safeQuery };
    } catch { await c.query("ROLLBACK").catch(() => {}); }
  }
  return { oldCost: null, findings: [], safeQuery: null };
}

async function verifyIndexBenefit(c, safeQuery, table, columns, predicate, oldCost) {
  const { predicateToSql, validateIdentifier } = require("../executor");
  validateIdentifier(table);
  columns.forEach(validateIdentifier);
  let create = `CREATE INDEX ON ${table} (${columns.join(", ")})`;
  if (predicate) create += ` WHERE ${predicateToSql(predicate)}`;
  try {
    await c.query("SELECT * FROM hypopg_create_index($1)", [create]);
    const { rows } = await c.query(`EXPLAIN (FORMAT JSON) ${safeQuery}`);
    const newCost = rows[0]["QUERY PLAN"][0].Plan["Total Cost"] ?? oldCost;
    return { improvement: calcImprovementPct(oldCost, newCost), newCost };
  } finally {
    await c.query("SELECT hypopg_reset();").catch(() => {});
  }
}

module.exports = {
  engine, supportsPartialIndexes,
  connect, close, ping, ensurePrerequisites,
  getSlowQueries, getUnusedIndexes, getAllIndexesForTable, getTableGrowthStats,
  analyzeQuery, verifyIndexBenefit,
};
