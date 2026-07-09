"use strict";
require("dotenv").config();

const SCHEME_TO_ENGINE = {
  postgres: "postgres", postgresql: "postgres",
  mysql: "mysql", mariadb: "mysql",
  mssql: "mssql", sqlserver: "mssql",
  oracle: "oracle", mongodb: "mongodb", mongo: "mongodb",
};
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433, oracle: 1521, mongodb: 27017 };

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
const bool = (v) => String(v).toLowerCase() === "true";

// Every setting must be provided explicitly — via a .env file in the working
// directory, real environment variables, or the matching CLI flag.
const REQUIRED_VARS = [
  "DATABASE_URL",
  "PORT",
  "SCAN_INTERVAL_MINUTES",
  "MIN_ROWS_FOR_SEQ_SCAN_FLAG",
  "MIN_IMPROVEMENT_PCT_TO_RECOMMEND",
  "AUTO_CREATE_INDEXES",
  "AUTO_DROP_UNUSED_INDEXES",
  "INDEX_NAME_PREFIX",
  "UNUSED_INDEX_GRACE_MINUTES",
  "REAPPLY_COOLDOWN_MINUTES",
  "STORAGE_LIMIT_MB",
  "STATE_DB_PATH",
];
{
  const missing = REQUIRED_VARS.filter((n) => env(n) === undefined);
  if (missing.length) {
    console.error(
      `dbopt: missing required environment variables:\n` +
      missing.map((n) => `  - ${n}`).join("\n") +
      `\n\nCreate a .env file in the directory you run dbopt from,\n` +
      `defining all of them (copy .env.example from the package for a template):\n` +
      `  node_modules/dbopt-engine/.env.example`
    );
    process.exit(1);
  }
}

const settings = {
  httpPort: parseInt(env("PORT", "1305"), 10),
  scanIntervalMinutes: parseInt(env("SCAN_INTERVAL_MINUTES", "15"), 10),
  minRowsForSeqScanFlag: parseInt(env("MIN_ROWS_FOR_SEQ_SCAN_FLAG", "1000"), 10),
  minImprovementPct: parseFloat(env("MIN_IMPROVEMENT_PCT_TO_RECOMMEND", "30")),
  autoCreateIndexes: bool(env("AUTO_CREATE_INDEXES", "true")),
  autoDropUnusedIndexes: bool(env("AUTO_DROP_UNUSED_INDEXES", "false")),
  indexNamePrefix: env("INDEX_NAME_PREFIX", "opt"),
  unusedIndexGraceMinutes: parseInt(env("UNUSED_INDEX_GRACE_MINUTES", "60"), 10),
  reapplyCooldownMinutes: parseInt(env("REAPPLY_COOLDOWN_MINUTES", "60"), 10),
  storageLimitMb: parseInt(env("STORAGE_LIMIT_MB", "0"), 10),
  historyRetentionDays: parseInt(env("HISTORY_RETENTION_DAYS", "90"), 10),
  stateDbPath: env("STATE_DB_PATH", "optimizer_state.db"),
  targets: [],
};

/** Parse one connection URL: engine://user:pass@host:port/db, plus the
 *  ADO-style variant engine://host:port;database=..;user=..;password=..  */
function parseDatabaseUrl(url) {
  url = url.trim().replace(/^["']|["']$/g, "");
  const sep = url.indexOf("://");
  if (sep < 0) throw new Error("DATABASE_URL must look like engine://user:pass@host:port/dbname");
  const scheme = url.slice(0, sep).toLowerCase();
  const rest = url.slice(sep + 3);
  const engine = SCHEME_TO_ENGINE[scheme];
  if (!engine) throw new Error(`Unknown DATABASE_URL scheme '${scheme}'`);

  const t = {
    dbEngine: engine,
    host: env("TARGET_DB_HOST", ""),
    port: 0,
    database: env("TARGET_DB_NAME", ""),
    user: env("TARGET_DB_USER", ""),
    password: env("TARGET_DB_PASSWORD", ""),
  };

  if (rest.includes(";")) {
    const [hostPart, ...params] = rest.split(";");
    const [host, port] = hostPart.split(":");
    const kv = {};
    for (const p of params) {
      const eq = p.indexOf("=");
      if (eq > 0) kv[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    }
    t.host = host;
    t.port = parseInt(port || kv.port || DEFAULT_PORTS[engine], 10);
    t.database = kv.database || kv.dbname || t.database;
    t.user = kv.user || kv.uid || kv.username || t.user;
    t.password = kv.password || kv.pwd || t.password;
  } else {
    const u = new URL(`${scheme === "mongodb" ? "mongodb" : "http"}://${rest}`);
    t.host = u.hostname;
    t.port = u.port ? parseInt(u.port, 10) : DEFAULT_PORTS[engine];
    t.database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (u.username) t.user = decodeURIComponent(u.username);
    if (u.password) t.password = decodeURIComponent(u.password);
  }
  if (!t.database) throw new Error(`DATABASE_URL '${scheme}://…' is missing the database name (/dbname)`);
  if (!t.port) t.port = DEFAULT_PORTS[engine] || 5432;
  return t;
}

/* DATABASE_URL holds one or more comma-separated connection URLs, so one
 * process can watch several databases at once. Commas inside passwords must
 * be URL-encoded as %2C (like the other special characters). */
const urls = String(process.env.DATABASE_URL).split(",").map((s) => s.trim()).filter(Boolean);
if (!urls.length) {
  console.error("dbopt: DATABASE_URL is empty — set at least one connection URL.");
  process.exit(1);
}
settings.targets = urls.map(parseDatabaseUrl);

/* Give each target a stable, human-friendly name for the API (?db=<name>)
 * and the dashboard selector: the database name, disambiguated by host and
 * port only when two targets share it. */
{
  const count = (fn) => settings.targets.reduce((m, t) => {
    const k = fn(t); m[k] = (m[k] || 0) + 1; return m;
  }, {});
  const byDb = count((t) => t.database);
  const byDbHost = count((t) => `${t.database}@${t.host}`);
  const seen = {};
  for (const t of settings.targets) {
    let name = t.database;
    if (byDb[t.database] > 1) name = `${t.database}@${t.host}`;
    if (byDbHost[`${t.database}@${t.host}`] > 1) name = `${t.database}@${t.host}:${t.port}`;
    if (seen[name]) name += `-${++seen[name]}`;
    else seen[name] = 1;
    t.name = name;
  }
}

module.exports = { settings };
