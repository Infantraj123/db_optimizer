"use strict";
/** Shared filter-string parsing (engine adapters normalize their plan
 *  predicates to "col = value" style strings before calling these). */

const stripCasts = (s) => s.replace(/::\w+(\s+\w+)?/g, "");

/** '(a = 1) AND (b = 2)' -> ['a','b'].  OR can't be served by one index ->
 *  first column only. */
function extractColumnsFromFilter(filterStr) {
  if (!filterStr) return [];
  const cleaned = stripCasts(filterStr);
  const cols = [...cleaned.matchAll(/\(*\s*(\w+)\s*\)*\s*=/g)].map((m) => m[1]);
  const unique = [...new Set(cols)];
  return / OR /.test(cleaned) ? unique.slice(0, 1) : unique;
}

/** Detect filters that call for a partial index (Postgres only). */
function extractPartialPredicate(filterStr) {
  if (!filterStr) return null;
  const cleaned = stripCasts(filterStr);
  let m = cleaned.match(/(\w+)\s+IS NOT NULL/);
  if (m) return { column: m[1], op: "IS NOT NULL" };
  m = cleaned.match(/(\w+)\s*=\s*(true|false)\b/);
  if (m) return { column: m[1], op: "=", value: m[2] };
  m = cleaned.match(/(?<![A-Z] )NOT\s+\(?(\w+)/);
  if (m) return { column: m[1], op: "=", value: "false" };
  m = cleaned.match(/^\(*\s*(\w+)\s*\)*$/);
  if (m) return { column: m[1], op: "=", value: "true" };
  return null;
}

const calcImprovementPct = (oldCost, newCost) =>
  !oldCost ? 0 : Math.round((1 - newCost / oldCost) * 1000) / 10;

module.exports = { extractColumnsFromFilter, extractPartialPredicate, calcImprovementPct };
