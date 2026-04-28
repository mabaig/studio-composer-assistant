/**
 * SCM API search tool — query the ingested OpenAPI database.
 *
 * Use as a module:
 *   const { searchApi, getPayloadSchema } = require('./search');
 *
 * Or as a CLI:
 *   node search.js search "create ASN"
 *   node search.js schema "/receivingTransactions" POST
 *   node search.js tag "Inventory Management"
 *   node search.js detail "createAdvancedShipmentNotice"
 *   node search.js ref "ReceivingTransaction"
 *   node search.js tags
 *   node search.js stats
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host:     process.env.PG_HOST     || 'localhost',
      port:     Number(process.env.PG_PORT || 5432),
      database: process.env.PG_DATABASE || 'scm_apis',
      user:     process.env.PG_USER     || 'postgres',
      password: process.env.PG_PASSWORD || '',
    };

const pool = new Pool(poolConfig);

/* ═══════════════════════════════════════════════════════════
   Tool: searchApi
   Ranked full-text + ILIKE fallback across path, operationId,
   summary, description, and tags.
═══════════════════════════════════════════════════════════ */
async function searchApi(query, { limit = 20 } = {}) {
  const words = query.trim().split(/\s+/).filter(Boolean);

  // Per-word ILIKE: "receiving transaction" matches "receivingTransactions"
  const wordParams = [];
  const wordClauses = words.map((w) => {
    wordParams.push(`%${w}%`);
    return `path ILIKE $${wordParams.length}`;
  });
  const allWordsInPath = wordClauses.length ? wordClauses.join(' AND ') : 'false';

  const base = wordParams.length;
  const { rows } = await pool.query(`
    SELECT
      method,
      path,
      operation_id,
      summary,
      tags,
      round(ts_rank(search_vec, plainto_tsquery('english', $${base + 1}))::numeric, 4) AS rank
    FROM scm_endpoints
    WHERE
      search_vec @@ plainto_tsquery('english', $${base + 1})
      OR (${allWordsInPath})
      OR summary      ILIKE $${base + 2}
      OR operation_id ILIKE $${base + 2}
    ORDER BY rank DESC, path, method
    LIMIT $${base + 3}
  `, [...wordParams, query, `%${query}%`, limit]);
  return rows;
}

/* ═══════════════════════════════════════════════════════════
   Tool: getPayloadSchema
   Returns parameters, request body, and response schemas for
   a given path fragment or operationId. Optionally filter by
   HTTP method.
═══════════════════════════════════════════════════════════ */
async function getPayloadSchema(identifier, method = null) {
  const args = [`%${identifier}%`];
  const methodClause = method ? `AND method = $2` : '';
  if (method) args.push(method.toUpperCase());

  const { rows } = await pool.query(`
    SELECT
      method,
      path,
      operation_id,
      summary,
      parameters,
      request_body,
      responses
    FROM scm_endpoints
    WHERE (path ILIKE $1 OR operation_id ILIKE $1)
    ${methodClause}
    ORDER BY path, method
    LIMIT 10
  `, args);
  return rows;
}

/* ═══════════════════════════════════════════════════════════
   Tool: getEndpointsByTag
   All endpoints whose tags array contains a match for the
   given module/category name (partial, case-insensitive).
═══════════════════════════════════════════════════════════ */
async function getEndpointsByTag(tag, { limit = 100 } = {}) {
  const { rows } = await pool.query(`
    SELECT method, path, operation_id, summary
    FROM scm_endpoints
    WHERE EXISTS (
      SELECT 1 FROM unnest(tags) t WHERE t ILIKE $1
    )
    ORDER BY path, method
    LIMIT $2
  `, [`%${tag}%`, limit]);
  return rows;
}

/* ═══════════════════════════════════════════════════════════
   Tool: getEndpointDetail
   Full details (including request/response) for a specific
   endpoint matched by path fragment or operationId.
═══════════════════════════════════════════════════════════ */
async function getEndpointDetail(identifier, method = null) {
  const args = [`%${identifier}%`];
  const methodClause = method ? `AND method = $2` : '';
  if (method) args.push(method.toUpperCase());

  const { rows } = await pool.query(`
    SELECT
      method, path, operation_id, summary, description,
      tags, parameters, request_body, responses, deprecated
    FROM scm_endpoints
    WHERE (path ILIKE $1 OR operation_id ILIKE $1)
    ${methodClause}
    ORDER BY path, method
    LIMIT 10
  `, args);
  return rows;
}

/* ═══════════════════════════════════════════════════════════
   Tool: resolveSchema
   Look up a reusable component schema by name or $ref string.
   e.g. "ReceivingTransaction"  or  "#/components/schemas/ReceivingTransaction"
═══════════════════════════════════════════════════════════ */
async function resolveSchema(refOrName) {
  const name = refOrName.replace(/^.*\//, '');   // strip any leading path
  const { rows } = await pool.query(`
    SELECT name, schema_def
    FROM scm_schemas
    WHERE name ILIKE $1
    LIMIT 10
  `, [`%${name}%`]);
  return rows;
}

/* ═══════════════════════════════════════════════════════════
   listTags — all available tags/modules
═══════════════════════════════════════════════════════════ */
async function listTags() {
  const { rows } = await pool.query(
    `SELECT name, description FROM scm_tags ORDER BY name`
  );
  return rows;
}

/* ═══════════════════════════════════════════════════════════
   stats — row counts + method breakdown
═══════════════════════════════════════════════════════════ */
async function stats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM scm_endpoints)::int AS total_endpoints,
      (SELECT COUNT(*) FROM scm_tags)::int      AS total_tags,
      (SELECT COUNT(*) FROM scm_schemas)::int   AS total_schemas,
      (SELECT json_object_agg(method, cnt)
       FROM (
         SELECT method, COUNT(*)::int AS cnt
         FROM scm_endpoints
         GROUP BY method
         ORDER BY cnt DESC
       ) m)                                     AS by_method
  `);
  return rows[0];
}

module.exports = {
  searchApi,
  getPayloadSchema,
  getEndpointsByTag,
  getEndpointDetail,
  resolveSchema,
  listTags,
  stats,
  pool,
};

/* ═══════════════════════════════════════════════════════════
   CLI
═══════════════════════════════════════════════════════════ */
if (require.main === module) {
  const [,, cmd, ...args] = process.argv;

  const HELP = `
SCM API Search Tool
───────────────────
node search.js search  <query>                Search by keyword
node search.js schema  <path|opId> [method]   Request/response schema
node search.js tag     <tag-name>             All endpoints for a module
node search.js detail  <path|opId> [method]   Full endpoint detail
node search.js ref     <schema-name|$ref>     Resolve component schema
node search.js tags                           List all tags/modules
node search.js stats                          Database statistics

Examples:
  node search.js search  "create ASN"
  node search.js search  "inventory receiving"
  node search.js schema  "/receivingTransactions" POST
  node search.js schema  "createAdvancedShipmentNotice"
  node search.js tag     "Inventory Management"
  node search.js detail  "getAvailableQuantity"
  node search.js ref     "ReceivingTransaction"
`;

  (async () => {
    try {
      let result;
      switch (cmd) {
        case 'search': result = await searchApi(args.join(' '));                    break;
        case 'schema': result = await getPayloadSchema(args[0], args[1] || null);  break;
        case 'tag':    result = await getEndpointsByTag(args.join(' '));            break;
        case 'detail': result = await getEndpointDetail(args[0], args[1] || null); break;
        case 'ref':    result = await resolveSchema(args.join(' '));               break;
        case 'tags':   result = await listTags();                                  break;
        case 'stats':  result = await stats();                                     break;
        default:       console.log(HELP); return;
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err.message);
      if (process.env.DEBUG) console.error(err.stack);
    } finally {
      await pool.end();
    }
  })();
}
