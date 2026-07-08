"use strict";

/** Engine name -> adapter module. Adapters are stateless: connection
 *  parameters come from the target object passed to connect(). */
function adapterFor(engine) {
  switch (engine) {
    case "postgres": return require("./postgres");
    case "mysql": return require("./mysql");
    case "mssql": return require("./mssql");
    case "oracle":
    case "mongodb":
      throw new Error(
        `Engine '${engine}' is not yet supported in the Node.js package ` +
        "(available in the Python edition). Supported here: postgres, mysql, mssql.");
    default:
      throw new Error(`Unsupported engine '${engine}' (use postgres, mysql or mssql)`);
  }
}

module.exports = { adapterFor };
