"use strict";
/** Schema topology API: real table graph + FK edges + query-flow parsing. */
const express = require("express");
const { settings } = require("./config");
const { withConn, wrap } = require("./routes");

const router = express.Router();

const FK_QUERIES = {
  postgres: `
    SELECT tc.table_name AS from_table, kcu.column_name AS from_column,
           ccu.table_name AS to_table, ccu.column_name AS to_column, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  mysql: `
    SELECT TABLE_NAME AS from_table, COLUMN_NAME AS from_column,
           REFERENCED_TABLE_NAME AS to_table, REFERENCED_COLUMN_NAME AS to_column, CONSTRAINT_NAME AS constraint_name
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
  mssql: `
    SELECT tp.name AS from_table, cp.name AS from_column, tr.name AS to_table,
           cr.name AS to_column, fk.name AS constraint_name
    FROM sys.foreign_key_columns fkc
    JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
    JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
    JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
    JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
    JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id`,
};

const COL_COUNT = {
  postgres: `SELECT table_name AS t, COUNT(*) AS n FROM information_schema.columns
             WHERE table_schema='public' GROUP BY table_name`,
  mysql: `SELECT TABLE_NAME AS t, COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME`,
  mssql: `SELECT t.name AS t, COUNT(*) AS n FROM sys.tables t
          JOIN sys.columns c ON c.object_id = t.object_id GROUP BY t.name`,
};
const IDX_COUNT = {
  postgres: `SELECT tablename AS t, COUNT(*) AS n FROM pg_indexes WHERE schemaname='public' GROUP BY tablename`,
  mysql: `SELECT TABLE_NAME AS t, COUNT(DISTINCT INDEX_NAME) AS n FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME`,
  mssql: `SELECT t.name AS t, COUNT(*) AS n FROM sys.tables t
          JOIN sys.indexes i ON i.object_id = t.object_id AND i.name IS NOT NULL GROUP BY t.name`,
};
const COLUMNS_OF = {
  postgres: { sql: `SELECT column_name AS name, data_type AS type, is_nullable AS nullable
                    FROM information_schema.columns WHERE table_schema='public' AND table_name = $1
                    ORDER BY ordinal_position`, style: "pg" },
  mysql: { sql: `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                 ORDER BY ORDINAL_POSITION`, style: "my" },
  mssql: { sql: `SELECT c.name, ty.name AS type,
                        CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS nullable
                 FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
                 WHERE c.object_id = OBJECT_ID(@t) ORDER BY c.column_id`, style: "ms" },
};

async function rawRows(engine, conn, sqlText, param) {
  if (engine === "postgres") {
    const { rows } = await conn.query(sqlText, param !== undefined ? [param] : undefined);
    return rows;
  }
  if (engine === "mysql") {
    const [rows] = await conn.query(sqlText, param !== undefined ? [param] : undefined);
    return rows;
  }
  const req = conn.request();
  if (param !== undefined) req.input("t", param);
  return (await req.query(sqlText)).recordset;
}

router.get("/topology/schema", wrap(async (req, res) => {
  const t = req.target;
  const data = await withConn(t, async (c) => {
    const tables = await t.adapter.getTableGrowthStats(c);
    const cols = await rawRows(t.dbEngine, c, COL_COUNT[t.dbEngine]);
    const idxs = await rawRows(t.dbEngine, c, IDX_COUNT[t.dbEngine]);
    const fks = await rawRows(t.dbEngine, c, FK_QUERIES[t.dbEngine]);
    return { tables, cols, idxs, fks };
  });
  const colMap = Object.fromEntries(data.cols.map((r) => [r.t, Number(r.n)]));
  const idxMap = Object.fromEntries(data.idxs.map((r) => [r.t, Number(r.n)]));
  const nodes = data.tables.map((t) => ({
    id: t.table_name, rows: t.live_rows, size: t.total_size,
    size_bytes: t.total_size_bytes,
    columns: colMap[t.table_name] ?? null, indexes: idxMap[t.table_name] ?? 0,
  }));
  const byKey = {};
  for (const f of data.fks) {
    const key = `${f.constraint_name}|${f.from_table}|${f.to_table}`;
    const e = (byKey[key] ||= { from: f.from_table, to: f.to_table,
      constraint: f.constraint_name, from_columns: [], to_columns: [] });
    e.from_columns.push(f.from_column);
    e.to_columns.push(f.to_column);
  }
  res.json({ engine: t.dbEngine, nodes, edges: Object.values(byKey) });
}));

router.get("/topology/table/:table", wrap(async (req, res) => {
  const table = req.params.table;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    return res.status(400).json({ detail: "Invalid table name" });
  }
  const t = req.target;
  const spec = COLUMNS_OF[t.dbEngine];
  const data = await withConn(t, async (c) => ({
    columns: await rawRows(t.dbEngine, c, spec.sql, table),
    indexes: await t.adapter.getAllIndexesForTable(c, table),
  }));
  res.json({ table, ...data });
}));

/* --------------------------- query flow parse -------------------------- */
const FROM_RE = /\bFROM\s+[\["`]?(\w+)[\]"`]?(?:\s+(?:AS\s+)?(\w+))?/i;
const JOIN_RE = /\b(LEFT|RIGHT|INNER|FULL|CROSS)?\s*(?:OUTER\s+)?JOIN\s+[\["`]?(\w+)[\]"`]?(?:\s+(?:AS\s+)?(\w+))?(?:\s+ON\s+([\s\S]+?))?(?=\b(?:LEFT|RIGHT|INNER|FULL|CROSS|JOIN|WHERE|GROUP|ORDER|LIMIT|FETCH)\b|$)/gi;
const KEYWORDS = new Set(["on","where","and","or","select","join","left","right","inner","outer","full","cross","group","order","as"]);

router.post("/topology/analyze-query", express.json(), wrap(async (req, res) => {
  const sqlText = (req.body || {}).sql || "";
  if (!sqlText.trim()) return res.status(400).json({ detail: "No SQL provided" });
  const m = FROM_RE.exec(sqlText);
  if (!m) return res.status(400).json({ detail: "Could not find a FROM clause" });

  const aliases = {};
  const rootTable = m[1];
  aliases[(m[2] || rootTable).toLowerCase()] = rootTable;
  aliases[rootTable.toLowerCase()] = rootTable;

  const steps = [{ table: rootTable, edge: null }];
  for (const jm of sqlText.matchAll(JOIN_RE)) {
    const [, joinType, table, alias, onClause] = jm;
    if (KEYWORDS.has(table.toLowerCase())) continue;
    aliases[(alias || table).toLowerCase()] = table;
    aliases[table.toLowerCase()] = table;
    let edge = null;
    if (onClause) {
      const pair = /(\w+)\.[\["`]?(\w+)[\]"`]?\s*=\s*(\w+)\.[\["`]?(\w+)[\]"`]?/.exec(onClause);
      if (pair) edge = {
        from: aliases[pair[1].toLowerCase()] || pair[1], from_column: pair[2],
        to: aliases[pair[3].toLowerCase()] || pair[3], to_column: pair[4],
      };
    }
    steps.push({ table, join_type: (joinType || "INNER").toUpperCase(), edge });
  }

  let cost = null;
  try {
    const r = await withConn(req.target, (c) =>
      req.target.adapter.analyzeQuery(c, sqlText, Number.MAX_SAFE_INTEGER));
    cost = r.oldCost;
  } catch { /* cost is optional */ }

  res.json({ steps, join_count: steps.length - 1, plan_cost: cost,
             engine: req.target.dbEngine, tables: steps.map((s) => s.table) });
}));

/* ------------------------------- alerts -------------------------------- */
router.get("/topology/alerts", wrap(async (req, res) => {
  const t = req.target;
  const alerts = [];
  const add = (level, message) => alerts.push({ level, message });

  for (const a of t.prerequisites.actions_needed || []) add("warning", `Setup needed: ${a}`);

  const { tables, slow } = await withConn(t, async (c) => ({
    tables: await t.adapter.getTableGrowthStats(c),
    slow: await t.adapter.getSlowQueries(c, 1, 1),
  }));
  const total = tables.reduce((s, x) => s + (x.total_size_bytes || 0), 0);
  const totalMb = total / 1048576;
  const growth = t.store.sizeGrowthPerDay();

  if (settings.storageLimitMb > 0) {
    const pct = (totalMb / settings.storageLimitMb) * 100;
    if (pct >= 90) add("critical",
      `RUNNING OUT OF STORAGE: database uses ${totalMb.toFixed(0)} MB of the ${settings.storageLimitMb} MB limit (${pct.toFixed(0)}%).`);
    else if (pct >= 75) add("warning",
      `Storage ${pct.toFixed(0)}% used (${totalMb.toFixed(0)} of ${settings.storageLimitMb} MB).`);
    if (growth && growth > 0) {
      const daysLeft = (settings.storageLimitMb * 1048576 - total) / growth;
      if (daysLeft < 7) add("critical",
        `At the current growth rate (+${(growth / 1048576).toFixed(1)} MB/day) storage runs out in ~${Math.max(daysLeft, 0).toFixed(1)} days.`);
      else if (daysLeft < 30) add("warning",
        `Storage projected full in ~${daysLeft.toFixed(0)} days (+${(growth / 1048576).toFixed(1)} MB/day).`);
    }
  } else if (growth && growth > 0) {
    add("info", `Database growing +${(growth / 1048576).toFixed(1)} MB/day (now ${totalMb.toFixed(0)} MB). Set STORAGE_LIMIT_MB for capacity alerts.`);
  }

  const pending = t.store.listRecommendations("pending");
  const missing = pending.filter((r) => r.type === "missing_index").length;
  const unusedMb = pending.filter((r) => r.type === "unused_index")
    .reduce((s, r) => s + (r.detail.size_mb || 0), 0);
  if (missing) add("info", settings.autoCreateIndexes
    ? `${missing} verified missing index(es) pending — auto-apply will handle them next cycle.`
    : `${missing} verified missing index(es) waiting for manual apply.`);
  if (unusedMb >= 10) add("info", `${unusedMb.toFixed(0)} MB reclaimable from unused indexes.`);

  const failed = t.store.listActions(20).filter((a) => a.status === "failed");
  if (failed.length) add("warning", `${failed.length} recent action(s) failed — see the dashboard actions table.`);
  if (slow[0] && (slow[0].mean_exec_time || 0) >= 2000) {
    add("warning", `Slowest query currently averages ${(slow[0].mean_exec_time / 1000).toFixed(1)}s per call.`);
  }

  res.json({
    alerts, total_size_mb: Math.round(totalMb * 10) / 10,
    growth_mb_per_day: growth ? Math.round((growth / 1048576) * 100) / 100 : null,
    storage_limit_mb: settings.storageLimitMb || null,
  });
}));

module.exports = { topologyRouter: router };
