/**
 * OpenAPI → PostgreSQL ingestor
 * Usage: node ingest.js <path-to-openapi.json>
 *
 * Drops and recreates scm_endpoints, scm_tags, scm_schemas every run.
 * Safe to re-run with a new OpenAPI file — always loads from scratch.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

/* ── Args ──────────────────────────────────────────────────── */
const FILE = process.argv[2];
if (!FILE) {
  console.error('Usage: node ingest.js <openapi-file.json>');
  process.exit(1);
}

/* ── DB pool ───────────────────────────────────────────────── */
const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || 'scm_apis',
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || '',
});

/* ── Schema ────────────────────────────────────────────────── */
const DDL = `
  DROP TABLE IF EXISTS scm_endpoints CASCADE;
  DROP TABLE IF EXISTS scm_tags      CASCADE;
  DROP TABLE IF EXISTS scm_schemas   CASCADE;

  CREATE TABLE scm_tags (
    id          SERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    description TEXT
  );

  CREATE TABLE scm_endpoints (
    id           SERIAL  PRIMARY KEY,
    path         TEXT    NOT NULL,
    method       TEXT    NOT NULL,
    operation_id TEXT,
    summary      TEXT,
    description  TEXT,
    tags         TEXT[]  NOT NULL DEFAULT '{}',
    parameters   JSONB   NOT NULL DEFAULT '[]',
    request_body JSONB,
    responses    JSONB   NOT NULL DEFAULT '{}',
    deprecated   BOOLEAN NOT NULL DEFAULT false,
    raw          JSONB,
    search_vec   TSVECTOR
  );

  CREATE TABLE scm_schemas (
    id         SERIAL PRIMARY KEY,
    name       TEXT   UNIQUE NOT NULL,
    schema_def JSONB  NOT NULL
  );

  CREATE INDEX scm_ep_fts    ON scm_endpoints USING GIN (search_vec);
  CREATE INDEX scm_ep_path   ON scm_endpoints (path);
  CREATE INDEX scm_ep_opid   ON scm_endpoints (operation_id);
  CREATE INDEX scm_ep_tags   ON scm_endpoints USING GIN (tags);
  CREATE INDEX scm_ep_method ON scm_endpoints (method);
  CREATE INDEX scm_sc_name   ON scm_schemas (name);
`;

/* ── HTTP methods we care about ────────────────────────────── */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/* ── Batch insert (500 rows at a time) ─────────────────────── */
const BATCH_SIZE = 500;

async function insertEndpointBatch(client, rows) {
  if (!rows.length) return;
  const params  = [];
  const tuples  = rows.map((r, i) => {
    const b = i * 11;
    params.push(
      r.path, r.method, r.operationId, r.summary, r.description,
      r.tags,        // JS array → TEXT[]
      r.parameters,  // JSON string
      r.requestBody, // JSON string or null
      r.responses,   // JSON string
      r.deprecated,
      r.raw          // JSON string
    );
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},` +
           `$${b+6}::text[],$${b+7}::jsonb,$${b+8}::jsonb,$${b+9}::jsonb,$${b+10},$${b+11}::jsonb)`;
  });

  await client.query(
    `INSERT INTO scm_endpoints
       (path,method,operation_id,summary,description,tags,parameters,request_body,responses,deprecated,raw)
     VALUES ${tuples.join(',')}`,
    params
  );
}

async function insertSchemaBatch(client, rows) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((r, i) => {
    params.push(r.name, r.def);
    return `($${i*2+1},$${i*2+2}::jsonb)`;
  });
  await client.query(
    `INSERT INTO scm_schemas (name, schema_def) VALUES ${tuples.join(',')}
     ON CONFLICT (name) DO UPDATE SET schema_def = EXCLUDED.schema_def`,
    params
  );
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  const absPath = path.resolve(FILE);

  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const sizeMB = (fs.statSync(absPath).size / 1024 / 1024).toFixed(1);
  console.log(`\nFile : ${absPath}`);
  console.log(`Size : ${sizeMB} MB`);

  console.log('Reading file…');
  const raw = fs.readFileSync(absPath, 'utf8');

  console.log('Parsing JSON…');
  const spec = JSON.parse(raw);

  const title   = spec.info?.title   || '(unknown)';
  const version = spec.info?.version || '';
  console.log(`API  : ${title} ${version}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* ── DDL ── */
    console.log('\nRecreating tables…');
    await client.query(DDL);

    /* ── Tags ── */
    const tags = Array.isArray(spec.tags) ? spec.tags : [];
    if (tags.length) {
      console.log(`Tags : ${tags.length}`);
      for (const t of tags) {
        await client.query(
          `INSERT INTO scm_tags (name, description) VALUES ($1,$2)
           ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description`,
          [t.name, t.description || null]
        );
      }
    }

    /* ── Endpoints ── */
    const pathMap  = spec.paths || {};
    const pathKeys = Object.keys(pathMap);
    console.log(`Paths: ${pathKeys.length} — ingesting endpoints…`);

    let epBatch = [];
    let epTotal = 0;

    for (const p of pathKeys) {
      const item       = pathMap[p];
      const pathParams = Array.isArray(item.parameters) ? item.parameters : [];

      for (const m of METHODS) {
        const op = item[m];
        if (!op) continue;

        epBatch.push({
          path:        p,
          method:      m.toUpperCase(),
          operationId: op.operationId  || null,
          summary:     op.summary      || null,
          description: op.description  || null,
          tags:        Array.isArray(op.tags) ? op.tags : [],
          parameters:  JSON.stringify([...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]),
          requestBody: op.requestBody  ? JSON.stringify(op.requestBody) : null,
          responses:   JSON.stringify(op.responses   || {}),
          deprecated:  Boolean(op.deprecated),
          raw:         JSON.stringify(op),
        });

        if (epBatch.length >= BATCH_SIZE) {
          await insertEndpointBatch(client, epBatch);
          epTotal += epBatch.length;
          process.stdout.write(`\r  → ${epTotal} endpoints`);
          epBatch = [];
        }
      }
    }

    if (epBatch.length) {
      await insertEndpointBatch(client, epBatch);
      epTotal += epBatch.length;
    }
    console.log(`\r  → ${epTotal} endpoints loaded`);

    /* ── Component schemas ── */
    const compSchemas = spec.components?.schemas || {};
    const schemaKeys  = Object.keys(compSchemas);

    if (schemaKeys.length) {
      console.log(`Schemas: ${schemaKeys.length}`);
      let sBatch = [];
      for (const name of schemaKeys) {
        sBatch.push({ name, def: JSON.stringify(compSchemas[name]) });
        if (sBatch.length >= BATCH_SIZE) {
          await insertSchemaBatch(client, sBatch);
          sBatch = [];
        }
      }
      if (sBatch.length) await insertSchemaBatch(client, sBatch);
    }

    /* ── Full-text search vectors ── */
    console.log('Building search index…');
    await client.query(`
      UPDATE scm_endpoints
      SET search_vec = to_tsvector('english',
        coalesce(path,         '') || ' ' ||
        coalesce(operation_id, '') || ' ' ||
        coalesce(summary,      '') || ' ' ||
        coalesce(description,  '') || ' ' ||
        coalesce(array_to_string(tags, ' '), '')
      )
    `);

    await client.query('COMMIT');

    const db = `${process.env.PG_DATABASE || 'scm_apis'} @ ${process.env.PG_HOST || 'localhost'}`;
    console.log(`\n✅  Ingestion complete`);
    console.log(`    Endpoints : ${epTotal}`);
    console.log(`    Schemas   : ${schemaKeys.length}`);
    console.log(`    Tags      : ${tags.length}`);
    console.log(`    Database  : ${db}\n`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
