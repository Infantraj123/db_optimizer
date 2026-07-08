"use strict";
/** One target object per configured database: connection config + engine
 *  adapter + a state store scoped to it + its prerequisites status. */
const { settings } = require("./config");
const { adapterFor } = require("./adapters");
const { storeFor } = require("./store");

const targets = settings.targets.map((cfg) => {
  const t = { ...cfg, adapter: adapterFor(cfg.dbEngine), prerequisites: { checked: false } };
  t.store = storeFor(t);
  return t;
});

/** No name -> the first (default) target; unknown name -> undefined. */
const getTarget = (name) => (name ? targets.find((t) => t.name === name) : targets[0]);

module.exports = { targets, getTarget };
