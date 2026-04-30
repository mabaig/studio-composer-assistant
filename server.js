require('dotenv').config();
const express = require('express');
const { Readable } = require('stream');
const path = require('path');
const { reviewFlexipage } = require('./reviewer');

/* ── Lazy Neon/PG pool for API search ─────────────────────── */
let _pgPool = null;
function getDbPool() {
  if (_pgPool) return _pgPool;
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = require('pg');
  _pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
  return _pgPool;
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const COMPOSER_API_URL =
  process.env.COMPOSER_API_URL ||
  'https://copilot-chat.intellinum.com/composer_skills/stream';

const COMPOSER_API_TOKEN = process.env.COMPOSER_API_TOKEN || '';

app.post('/api/stream', async (req, res) => {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (COMPOSER_API_TOKEN) headers['Authorization'] = `Bearer ${COMPOSER_API_TOKEN}`;

    const upstream = await fetch(COMPOSER_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: errText });
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('[/api/stream]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/* ── SCM API search ────────────────────────────────────────── */
app.get('/api/search-api', async (req, res) => {
  const pool = getDbPool();
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  const q   = (req.query.q || '').trim();
  const tag = (req.query.tag || '').trim();

  if (!q && !tag) return res.json([]);

  try {
    if (tag && !q) {
      const { rows } = await pool.query(`
        SELECT method, path, operation_id, summary, tags, 0.0::numeric AS rank
        FROM scm_endpoints
        WHERE $1 = ANY(tags)
        ORDER BY path, method
        LIMIT 100
      `, [tag]);
      return res.json(rows);
    }

    const words    = q.split(/\s+/).filter(Boolean);
    const wParams  = words.map((w) => `%${w}%`);
    const wClause  = words.map((_, i) => `path ILIKE $${i + 1}`).join(' AND ');
    const base     = words.length;
    const tagFilter = tag ? `AND $${base + 3} = ANY(tags)` : '';
    const qParams   = [...wParams, q, `%${q}%`];
    if (tag) qParams.push(tag);

    const { rows } = await pool.query(`
      SELECT method, path, operation_id, summary, tags,
        round(ts_rank(search_vec, plainto_tsquery('english', $${base+1}))::numeric, 4) AS rank
      FROM scm_endpoints
      WHERE (search_vec @@ plainto_tsquery('english', $${base+1})
        OR (${wClause || 'false'})
        OR summary      ILIKE $${base+2}
        OR operation_id ILIKE $${base+2})
        ${tagFilter}
      ORDER BY rank DESC, path, method
      LIMIT 50
    `, qParams);
    res.json(rows);
  } catch (err) {
    console.error('[/api/search-api]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── SCM tags list ─────────────────────────────────────────── */
app.get('/api/scm-tags', async (req, res) => {
  const pool = getDbPool();
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { rows } = await pool.query(`
      SELECT t.name, t.description,
        (SELECT count(*) FROM scm_endpoints WHERE t.name = ANY(tags))::int AS count
      FROM scm_tags t
      ORDER BY count DESC, t.name
      LIMIT 60
    `);
    res.json(rows);
  } catch (err) {
    console.error('[/api/scm-tags]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── SCM API proxy (Try It) ────────────────────────────────── */
app.post('/api/scm-execute', async (req, res) => {
  const baseUrl  = (process.env.SCM_BASE_URL || '').replace(/\/$/, '');
  const username = process.env.SCM_USERNAME || '';
  const password = process.env.SCM_PASSWORD || '';

  if (!baseUrl) return res.status(503).json({ error: 'SCM_BASE_URL not configured in .env' });

  const { method, path: apiPath, queryParams, body } = req.body;
  if (!method || !apiPath) return res.status(400).json({ error: 'method and path required' });

  try {
    const url = new URL(baseUrl + apiPath);
    if (queryParams && typeof queryParams === 'object') {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== '' && v != null) url.searchParams.set(k, v);
      }
    }

    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (username || password) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }

    const upRes = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: ['POST','PUT','PATCH'].includes(method.toUpperCase()) && body ? body : undefined,
    });

    const ct  = upRes.headers.get('content-type') || '';
    const raw = await upRes.text().catch(() => '');
    let data;
    if (ct.includes('json') && raw) {
      try { data = JSON.parse(raw); } catch { data = raw; }
    } else {
      data = raw || null;
    }

    res.json({ status: upRes.status, statusText: upRes.statusText, data });
  } catch (err) {
    console.error('[/api/scm-execute]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── SCM schema lookup ─────────────────────────────────────── */
app.get('/api/schema', async (req, res) => {
  const pool = getDbPool();
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name param required' });

  try {
    const { rows } = await pool.query(
      'SELECT name, schema_def FROM scm_schemas WHERE name = $1',
      [name]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('[/api/schema]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── SCM endpoint detail ───────────────────────────────────── */
app.get('/api/endpoint-detail', async (req, res) => {
  const pool = getDbPool();
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  const { path: p, method } = req.query;
  if (!p) return res.status(400).json({ error: 'path param required' });

  try {
    const args = [p];
    const mClause = method ? `AND method = $2` : '';
    if (method) args.push(method.toUpperCase());

    const { rows } = await pool.query(`
      SELECT method, path, operation_id, summary, description,
             tags, parameters, request_body, responses
      FROM scm_endpoints
      WHERE path = $1 ${mClause}
      ORDER BY method
    `, args);
    res.json(rows);
  } catch (err) {
    console.error('[/api/endpoint-detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── JavaDoc search ────────────────────────────────────────── */
app.get('/api/search-javadoc', async (req, res) => {
  const pool = getDbPool();
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    const like = `%${q}%`;
    const { rows } = await pool.query(`
      SELECT 'class' AS result_type,
             id, class_name AS name, qualified_name, package_name, class_type, summary,
             NULL::text AS member_type, NULL::text AS signature, NULL::text AS return_type,
             NULL::integer AS class_id, NULL::text AS qualified_class_name,
             round(ts_rank(search_vec, plainto_tsquery('english', $1))::numeric, 4) AS rank
      FROM javadoc_classes
      WHERE search_vec @@ plainto_tsquery('english', $1)
         OR class_name    ILIKE $2
         OR qualified_name ILIKE $2

      UNION ALL

      SELECT 'member' AS result_type,
             id, name, NULL AS qualified_name, NULL AS package_name, NULL AS class_type, summary,
             member_type, signature, return_type,
             class_id, qualified_class_name,
             round(ts_rank(search_vec, plainto_tsquery('english', $1))::numeric, 4) AS rank
      FROM javadoc_members
      WHERE search_vec @@ plainto_tsquery('english', $1)
         OR name         ILIKE $2
         OR class_name   ILIKE $2

      ORDER BY rank DESC, name
      LIMIT 25
    `, [q, like]);
    res.json(rows);
  } catch (err) {
    console.error('[/api/search-javadoc]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── JavaDoc class detail ──────────────────────────────────── */
app.get('/api/javadoc-class', async (req, res) => {
  const pool = getDbPool();
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name param required' });

  try {
    const clsRes = await pool.query(
      `SELECT * FROM javadoc_classes WHERE lower(qualified_name) = lower($1) OR lower(class_name) = lower($1) LIMIT 1`,
      [name]
    );
    if (!clsRes.rows.length) return res.json(null);
    const cls = clsRes.rows[0];

    const memRes = await pool.query(
      `SELECT member_type, name, signature, return_type, summary
       FROM javadoc_members WHERE class_id = $1
       ORDER BY member_type, name`,
      [cls.id]
    );
    res.json({ cls, members: memRes.rows });
  } catch (err) {
    console.error('[/api/javadoc-class]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/review', (req, res) => {
  const { flexipage } = req.body;
  if (!flexipage) return res.status(400).json({ error: 'Missing flexipage in request body' });
  try {
    res.json(reviewFlexipage(flexipage));
  } catch (err) {
    console.error('[/api/review]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nStudio Composer Assistant`);
  console.log(`→ http://localhost:${PORT}\n`);
});
