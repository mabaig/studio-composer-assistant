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

  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    const words    = q.split(/\s+/).filter(Boolean);
    const wParams  = words.map((w) => `%${w}%`);
    const wClause  = words.map((_, i) => `path ILIKE $${i + 1}`).join(' AND ');
    const base     = words.length;

    const { rows } = await pool.query(`
      SELECT method, path, operation_id, summary, tags,
        round(ts_rank(search_vec, plainto_tsquery('english', $${base+1}))::numeric, 4) AS rank
      FROM scm_endpoints
      WHERE search_vec @@ plainto_tsquery('english', $${base+1})
        OR (${wClause || 'false'})
        OR summary      ILIKE $${base+2}
        OR operation_id ILIKE $${base+2}
      ORDER BY rank DESC, path, method
      LIMIT 20
    `, [...wParams, q, `%${q}%`]);
    res.json(rows);
  } catch (err) {
    console.error('[/api/search-api]', err.message);
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
