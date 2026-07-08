#!/usr/bin/env node
"use strict";

/* Simple CLI: flags map onto env vars before config loads.
 *   dbopt --database-url mysql://u:p@host:3306/db --port 8000
 */
const args = process.argv.slice(2);
const FLAG_TO_ENV = {
  "--database-url": "DATABASE_URL",
  "--port": "PORT",
  "--scan-interval": "SCAN_INTERVAL_MINUTES",
  "--auto-create": "AUTO_CREATE_INDEXES",
  "--auto-drop": "AUTO_DROP_UNUSED_INDEXES",
  "--min-improvement": "MIN_IMPROVEMENT_PCT_TO_RECOMMEND",
  "--storage-limit-mb": "STORAGE_LIMIT_MB",
  "--state-db": "STATE_DB_PATH",
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help" || args[i] === "-h") {
    console.log(`dbopt — self-optimizing database engine

Usage:
  dbopt --database-url <engine://user:pass@host:port/db> [options]

Options:
  --database-url <urls>   postgres:// | mysql:// | sqlserver:// connection string;
                          comma-separate several to watch multiple databases
  --port <n>              HTTP port for dashboard/API (default 8000)
  --scan-interval <min>   analysis cycle interval in minutes (default 15)
  --auto-create <bool>    create verified indexes automatically (default true)
  --auto-drop <bool>      drop unused indexes automatically (default false)
  --min-improvement <pct> required cost improvement to act (default 30)
  --storage-limit-mb <n>  capacity for out-of-storage alerts (default off)
  --state-db <path>       SQLite history file (default optimizer_state.db)

Environment variables (or a .env file) work too; flags win.
Dashboard: http://localhost:<port>/dashboard · Topology: /topology`);
    process.exit(0);
  }
  const env = FLAG_TO_ENV[args[i]];
  if (env) {
    process.env[env] = args[i + 1];
    i++;
  }
}

require("../src/index").start().catch((e) => {
  console.error("Failed to start:", e.message);
  process.exit(1);
});
