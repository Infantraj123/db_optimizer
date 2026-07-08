"use strict";
const path = require("path");
const express = require("express");
const { settings } = require("./config");
const { targets, getTarget } = require("./targets");
const { router } = require("./routes");
const { topologyRouter } = require("./topology");
const { runAnalysisCycle, startScheduler } = require("./scheduler");

function createApp() {
  const app = express();
  app.use(express.json());

  // Every API call is scoped to one target database, chosen with ?db=<name>
  // (see GET /targets). Without the parameter the first target is used.
  app.use((req, res, next) => {
    req.target = getTarget(req.query.db);
    if (!req.target) {
      return res.status(404).json({
        detail: `Unknown database '${req.query.db}'. Configured: ${targets.map((t) => t.name).join(", ")}`,
      });
    }
    next();
  });

  app.use(router);
  app.use(topologyRouter);

  const page = (file) => (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "static", file));
  };
  app.get("/dashboard", page("dashboard.html"));
  app.get("/topology", page("topology.html"));
  app.get("/", (req, res) => res.redirect("/dashboard"));
  return app;
}

async function start() {
  const app = createApp();
  app.listen(settings.httpPort, () => {
    console.log(`dbopt listening on http://localhost:${settings.httpPort}`);
    for (const t of targets) {
      console.log(`  target '${t.name}': ${t.dbEngine} · ${t.host}:${t.port}/${t.database}`);
    }
    console.log(`  dashboard: http://localhost:${settings.httpPort}/dashboard`);
    console.log(`  topology:  http://localhost:${settings.httpPort}/topology`);
  });
  for (const t of targets) await t.adapter.ensurePrerequisites(t);
  startScheduler();
  runAnalysisCycle(); // immediate first cycle, like the Python edition
  return app;
}

module.exports = { createApp, start };
