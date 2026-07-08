"use strict";
/** Builds and executes index DDL with identifier validation; every action is
 *  recorded with rollback SQL. All functions are scoped to one target. */
const { settings } = require("./config");

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_IDENTIFIER = { postgres: 63, mysql: 64, mssql: 128 };

function validateIdentifier(name) {
  if (!name || !SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe identifier rejected: ${JSON.stringify(name)}`);
  }
}

function indexNameFor(engine, table, columns, partial = false) {
  let name = `${settings.indexNamePrefix}_idx_${table}_${columns.join("_")}`;
  if (partial) name += "_part";
  return name.slice(0, MAX_IDENTIFIER[engine] || 63);
}

function predicateToSql(predicate) {
  validateIdentifier(predicate.column || "");
  if (predicate.op === "IS NOT NULL") return `${predicate.column} IS NOT NULL`;
  if (predicate.op === "=" && ["true", "false"].includes(predicate.value)) {
    return `${predicate.column} = ${predicate.value}`;
  }
  throw new Error(`Unsupported partial-index predicate: ${JSON.stringify(predicate)}`);
}

function buildSqlForRecommendation(target, rec) {
  validateIdentifier(rec.table);
  const engine = target.dbEngine;
  const prefixNote = `The ${settings.indexNamePrefix}_ name prefix keeps this index outside any ORM/migration namespace.`;

  if (rec.type === "missing_index") {
    const columns = rec.detail.columns;
    columns.forEach(validateIdentifier);
    const predicate = rec.detail.predicate || null;
    const colList = columns.join(", ");

    if (engine === "mysql" || engine === "mssql") {
      if (predicate) throw new Error("Partial indexes are Postgres-only");
      const indexName = indexNameFor(engine, rec.table, columns);
      validateIdentifier(indexName);
      return {
        index_name: indexName,
        apply_sql: `CREATE INDEX ${indexName} ON ${rec.table} (${colList});`,
        rollback_sql: `DROP INDEX ${indexName} ON ${rec.table};`,
        notes: (engine === "mysql"
          ? "InnoDB online DDL builds the index without locking the table. "
          : "On Enterprise/Azure use WITH (ONLINE = ON) for fully non-blocking builds. ") + prefixNote,
      };
    }
    const where = predicate ? ` WHERE ${predicateToSql(predicate)}` : "";
    const indexName = indexNameFor(engine, rec.table, columns, !!predicate);
    validateIdentifier(indexName);
    return {
      index_name: indexName,
      apply_sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${rec.table} (${colList})${where};`,
      rollback_sql: `DROP INDEX CONCURRENTLY IF EXISTS ${indexName};`,
      notes: "CONCURRENTLY avoids locking the table. " + prefixNote,
    };
  }

  if (rec.type === "unused_index") {
    const indexName = rec.detail.index_name;
    validateIdentifier(indexName);
    const rollback = rec.detail.original_index_definition ||
      `-- Original definition not captured for ${indexName}.`;
    const dropSql = engine === "postgres"
      ? `DROP INDEX CONCURRENTLY IF EXISTS ${indexName};`
      : `DROP INDEX ${indexName} ON ${rec.table};`;
    return {
      index_name: indexName,
      apply_sql: dropSql,
      rollback_sql: rollback,
      notes: "Zero usage only reflects activity since the last stats reset / server start. " +
             "The original definition is stored as rollback_sql so the drop is fully reversible.",
    };
  }
  throw new Error(`Unknown recommendation type: ${rec.type}`);
}

async function execDdl(target, sqlText) {
  const conn = await target.adapter.connect(target);
  try {
    if (target.adapter.engine === "mssql") await conn.request().batch(sqlText);
    else await conn.query(sqlText);
  } finally {
    target.adapter.close(conn);
  }
}

async function applyRecommendation(target, rec) {
  try {
    const built = buildSqlForRecommendation(target, rec);
    await execDdl(target, built.apply_sql);
    console.log(`[executor] [${target.name}] applied rec #${rec.id}: ${built.apply_sql}`);
    target.store.updateDetail(rec.id, { ...rec.detail, index_name: built.index_name });
    return target.store.markApplied(rec.id, built.apply_sql, built.rollback_sql);
  } catch (e) {
    console.error(`[executor] [${target.name}] failed rec #${rec.id}: ${e.message}`);
    return target.store.markFailed(rec.id, e.message);
  }
}

async function rollbackRecommendation(target, rec) {
  let rollbackSql = rec.rollback_sql;
  if (rec.status !== "applied" || !rollbackSql) {
    throw new Error("Recommendation is not in an applied state with rollback SQL.");
  }
  if (rollbackSql.trimStart().startsWith("--")) {
    throw new Error("No executable rollback SQL was captured for this recommendation.");
  }
  if (target.dbEngine === "postgres" && rec.type === "unused_index" &&
      rollbackSql.toUpperCase().startsWith("CREATE INDEX ")) {
    rollbackSql = "CREATE INDEX CONCURRENTLY " + rollbackSql.slice("CREATE INDEX ".length);
  }
  await execDdl(target, rollbackSql);
  console.log(`[executor] [${target.name}] rolled back rec #${rec.id}`);
  return target.store.updateStatus(rec.id, "rolled_back");
}

module.exports = {
  validateIdentifier, indexNameFor, predicateToSql,
  buildSqlForRecommendation, applyRecommendation, rollbackRecommendation,
};
