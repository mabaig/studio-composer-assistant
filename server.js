require('dotenv').config();
const express = require('express');
const { Readable } = require('stream');
const path = require('path');
const { reviewFlexipage } = require('./reviewer');

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
