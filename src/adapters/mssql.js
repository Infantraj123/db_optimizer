"use strict";
/** SQL Server 2017+ adapter: DMVs + SHOWPLAN_XML + real trial-index builds.
 *  Uses a max-1 connection pool per cycle so session settings (SHOWPLAN)
 *  stick across sequential statements. */
const sql = require("mssql");
const { XMLParser } = require("fast-xml-parser");
const { calcImprovementPct } = require("../planParser");

const engine = "mssql";
const supportsPartialIndexes = false;
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

async function connect(target) {
  const pool = new sql.ConnectionPool({
    server: target.host, port: target.port, database: target.database,
    user: target.user, password: target.password,
    pool: { max: 1, min: 0 },
    options: { encrypt: true, trustServerCertificate: true },
    requestTimeout: 120000,
  });
  await pool.connect();
  return pool;
}
const close = (p) => p.close().catch(() => {});
const ping = async (p) => { await p.request().query("SELECT 1"); };

async function ensurePrerequisites(target) {
  const status = { checked: true, dmv_access: false, actions_needed: [] };
  let p;
  try {
    p = await connect(target);
    try {
      await p.request().query("SELECT TOP 1 execution_count FROM sys.dm_exec_query_stats;");
      status.dmv_access = true;
    } catch {
      status.actions_needed.push(
        `The login cannot read performance DMVs. Run as an admin (in master): ` +
        `GRANT VIEW SERVER STATE TO [${target.user}]; ` +
        `(on Azure SQL DB: GRANT VIEW DATABASE STATE instead).`);
    }
  } catch (e) {
    status.actions_needed.push(`Could not connect to the target database: ${e.message}`);
  } finally { if (p) close(p); }
  Object.assign(target.prerequisites, status);
  return status;
}

async function getSlowQueries(p, minCalls = 1, limit = 30) {
  try {
    const r = await p.request()
      .input("lim", sql.Int, limit).input("minc", sql.Int, minCalls)
      .query(`
        SELECT TOP (@lim)
               CONVERT(varchar(32), qs.query_hash, 2) AS queryid,
               SUBSTRING(t.text, (qs.statement_start_offset / 2) + 1,
                 ((CASE WHEN qs.statement_end_offset = -1 THEN DATALENGTH(t.text)
                        ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2) + 1) AS query,
               qs.execution_count AS calls,
               qs.total_elapsed_time / 1000.0 / qs.execution_count AS mean_exec_time,
               qs.total_elapsed_time / 1000.0 AS total_exec_time,
               qs.total_rows AS rows
        FROM sys.dm_exec_query_stats qs
        CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
        WHERE t.dbid = DB_ID() AND qs.execution_count >= @minc
          AND t.text NOT LIKE 'SET SHOWPLAN%' AND t.text NOT LIKE '%dm_exec_query_stats%'
          AND t.text NOT LIKE 'CREATE%' AND t.text NOT LIKE 'DROP%'
          AND t.text NOT LIKE 'ALTER%' AND t.text NOT LIKE 'INSERT%'
        ORDER BY mean_exec_time DESC;`);
    return r.recordset;
  } catch (e) {
    console.warn("[mssql] cannot read query stats (VIEW SERVER STATE missing?):", e.message.slice(0, 100));
    return [];
  }
}

async function getUnusedIndexes(p, target) {
  try {
    const r = await p.request().query(`
      SELECT o.name AS table_name, i.name AS index_name,
             COALESCE(u.user_seeks + u.user_scans + u.user_lookups, 0) AS idx_scan,
             COALESCE((SELECT SUM(ps.used_page_count) * 8 * 1024 FROM sys.dm_db_partition_stats ps
                       WHERE ps.object_id = i.object_id AND ps.index_id = i.index_id), 0) AS size_bytes,
             (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal)
              FROM sys.index_columns ic
              JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                AND ic.is_included_column = 0) AS columns_list
      FROM sys.indexes i
      JOIN sys.objects o ON o.object_id = i.object_id AND o.type = 'U'
      LEFT JOIN sys.dm_db_index_usage_stats u
        ON u.object_id = i.object_id AND u.index_id = i.index_id AND u.database_id = DB_ID()
      WHERE i.type = 2 AND i.is_primary_key = 0 AND i.is_unique = 0
        AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0 AND i.is_disabled = 0
        AND COALESCE(u.user_seeks + u.user_scans + u.user_lookups, 0) = 0;`);
    return r.recordset.map(x => ({
      schemaname: target.database, table_name: x.table_name, index_name: x.index_name,
      idx_scan: Number(x.idx_scan), size_bytes: Number(x.size_bytes || 0),
      indexdef: `CREATE INDEX ${x.index_name} ON ${x.table_name} (${x.columns_list})`,
    }));
  } catch (e) {
    console.warn("[mssql] cannot read index usage stats:", e.message.slice(0, 100));
    return [];
  }
}

async function getAllIndexesForTable(p, table) {
  const r = await p.request().input("t", sql.NVarChar, table).query(`
    SELECT i.name AS n,
           (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal)
            FROM sys.index_columns ic
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id) AS cols
    FROM sys.indexes i WHERE i.object_id = OBJECT_ID(@t) AND i.name IS NOT NULL;`);
  return r.recordset.map(x => ({ indexname: x.n, indexdef: `INDEX ${x.n} ON ${table} (${x.cols})` }));
}

function prettySize(b) {
  for (const u of ["bytes", "kB", "MB", "GB"]) {
    if (b < 1024) return `${Math.round(b)} ${u}`;
    b /= 1024;
  }
  return `${Math.round(b)} TB`;
}

async function getTableGrowthStats(p) {
  const r = await p.request().query(`
    SELECT t.name AS table_name,
           SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS live_rows,
           SUM(ps.reserved_page_count) * 8 * 1024 AS total_size_bytes
    FROM sys.tables t
    JOIN sys.dm_db_partition_stats ps ON ps.object_id = t.object_id
    GROUP BY t.name ORDER BY total_size_bytes DESC;`);
  return r.recordset.map(x => ({
    table_name: x.table_name, live_rows: Number(x.live_rows || 0), dead_rows: 0,
    total_size: prettySize(Number(x.total_size_bytes || 0)),
    total_size_bytes: Number(x.total_size_bytes || 0), seq_scan: 0, idx_scan: 0,
  }));
}

const substitute = (q, asString) =>
  q.replace(/^\s*\(@[^)]*\)\s*/, "").replace(/@\w+/g, asString ? "'1'" : "1");

async function estimatedPlan(p, safeQuery) {
  // max:1 pool -> sequential requests share the session, so SHOWPLAN sticks
  await p.request().batch("SET SHOWPLAN_XML ON;");
  try {
    const r = await p.request().batch(safeQuery);
    const row = r.recordset && r.recordset[0];
    return xml.parse(row[Object.keys(row)[0]]);
  } finally {
    await p.request().batch("SET SHOWPLAN_XML OFF;").catch(() => {});
  }
}

function collectRelOps(node, out) {
  if (node && typeof node === "object") {
    if (node["@_PhysicalOp"]) out.push(node);
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("@_")) continue;
      if (Array.isArray(v)) v.forEach(x => collectRelOps(x, out));
      else collectRelOps(v, out);
    }
  }
  return out;
}
function findFirst(node, key) {
  if (!node || typeof node !== "object") return null;
  if (node[key] !== undefined) return node[key];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@_")) continue;
    const hit = Array.isArray(v) ? v.map(x => findFirst(x, key)).find(Boolean) : findFirst(v, key);
    if (hit) return hit;
  }
  return null;
}

const cleanPredicate = (s) =>
  s.replace(/[\[\]]/g, "").replace(/\b\w+\.(\w+\.)*/g, "");

async function analyzeQuery(p, queryText, minRows) {
  for (const asString of [false, true]) {
    const safeQuery = substitute(queryText, asString);
    if (!safeQuery.trim()) continue;
    let plan;
    try { plan = await estimatedPlan(p, safeQuery); } catch { continue; }
    const stmt = findFirst(plan, "StmtSimple");
    const stmtNode = Array.isArray(stmt) ? stmt[0] : stmt;
    const oldCost = stmtNode ? parseFloat(stmtNode["@_StatementSubTreeCost"]) || null : null;
    const findings = [];
    for (const rel of collectRelOps(plan, [])) {
      if (!["Table Scan", "Clustered Index Scan"].includes(rel["@_PhysicalOp"])) continue;
      const rows = parseFloat(rel["@_EstimatedRowsRead"] || 0)
        || parseFloat(rel["@_TableCardinality"] || 0)
        || parseFloat(rel["@_EstimateRows"] || 0);
      if (rows <= minRows) continue;
      const obj = findFirst(rel, "Object");
      const objNode = Array.isArray(obj) ? obj[0] : obj;
      const table = objNode ? String(objNode["@_Table"] || "").replace(/[\[\]]/g, "") : null;
      const pred = findFirst(rel, "Predicate");
      const scalar = pred ? findFirst(pred, "ScalarOperator") : null;
      const scalarNode = Array.isArray(scalar) ? scalar[0] : scalar;
      const filter = scalarNode && scalarNode["@_ScalarString"]
        ? cleanPredicate(scalarNode["@_ScalarString"]) : null;
      findings.push({ table, filter, rows_scanned: Math.round(rows), cost: null });
    }
    return { oldCost, findings, safeQuery };
  }
  return { oldCost: null, findings: [], safeQuery: null };
}

async function verifyIndexBenefit(p, safeQuery, table, columns, predicate, oldCost) {
  const { indexNameFor, validateIdentifier } = require("../executor");
  if (predicate) throw new Error("Filtered-index candidates are not wired up for SQL Server yet");
  validateIdentifier(table);
  columns.forEach(validateIdentifier);
  const indexName = indexNameFor(engine, table, columns);
  let created = false;
  try {
    await p.request().batch(`CREATE INDEX ${indexName} ON ${table} (${columns.join(", ")})`);
    created = true;
    const plan = await estimatedPlan(p, safeQuery);
    const stmt = findFirst(plan, "StmtSimple");
    const stmtNode = Array.isArray(stmt) ? stmt[0] : stmt;
    const newCost = stmtNode ? parseFloat(stmtNode["@_StatementSubTreeCost"]) || oldCost : oldCost;
    return { improvement: calcImprovementPct(oldCost, newCost), newCost };
  } finally {
    if (created) await p.request().batch(`DROP INDEX ${indexName} ON ${table}`).catch(() => {});
  }
}

module.exports = {
  engine, supportsPartialIndexes,
  connect, close, ping, ensurePrerequisites,
  getSlowQueries, getUnusedIndexes, getAllIndexesForTable, getTableGrowthStats,
  analyzeQuery, verifyIndexBenefit,
};
