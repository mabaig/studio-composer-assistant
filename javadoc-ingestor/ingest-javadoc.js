/**
 * ingest-javadoc.js
 * Parses the flexipro-javadoc HTML tree and loads classes + members into Neon PostgreSQL.
 *
 * Usage:
 *   node javadoc-ingestor/ingest-javadoc.js [/path/to/javadoc-root]
 *
 * Defaults to: ./public/flexipro-javadoc
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const JAVADOC_DIR = process.argv[2]
  || path.join(__dirname, '../public/flexipro-javadoc');

if (!fs.existsSync(JAVADOC_DIR)) {
  console.error(`JavaDoc directory not found: ${JAVADOC_DIR}`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

/* ── HTML helpers ──────────────────────────────────────────────────────── */

function stripTags(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ').trim();
}

function firstMatch(html, rx) {
  const m = html.match(rx);
  return m ? stripTags(m[1]).trim() : '';
}

/* ── Parse allclasses-noframe.html ─────────────────────────────────────── */

function parseAllClasses(dir) {
  const src  = fs.readFileSync(path.join(dir, 'allclasses-noframe.html'), 'utf8');
  const refs = [];
  const rx   = /<a\s+href="([^"]+)"\s+title="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const href  = m[1].trim();
    const title = m[2].trim();  // "class in com.package"
    const name  = m[3].trim();
    const tm    = title.match(/^(\w+)\s+in\s+(.+)$/);
    refs.push({
      filePath:  href,
      name,
      classType: tm ? tm[1].toLowerCase() : 'class',
      pkg:       tm ? tm[2].trim() : '',
    });
  }
  return refs;
}

/* ── Parse a single class HTML file ────────────────────────────────────── */

function parseClassHtml(html, ref) {
  /* Package — from the .subTitle div */
  const pkg = firstMatch(html, /class="subTitle"[^>]*>([\s\S]*?)<\/div>/) || ref.pkg;

  /* Class name — strip generics and "Class / Interface / Enum" prefix */
  let rawTitle = firstMatch(html, /<h2[^>]*class="title"[^>]*>([\s\S]*?)<\/h2>/);
  rawTitle = rawTitle.replace(/^(Class|Interface|Enum|Annotation Type)\s+/i, '').split('<')[0].trim();

  /* First description block */
  const summary = firstMatch(html, /class="block"[^>]*>([\s\S]*?)<\/div>/).slice(0, 600);

  const qualifiedName = pkg ? `${pkg}.${ref.name}` : ref.name;

  const cls = {
    class_name:     ref.name,
    qualified_name: qualifiedName,
    package_name:   pkg,
    class_type:     ref.classType,
    summary,
  };

  /* ── Member summary tables ─────────────────────────────────────────── */
  const members = [];

  const tableRx = /<table[^>]*class="memberSummary"[^>]*>([\s\S]*?)<\/table>/g;
  let tbl;
  while ((tbl = tableRx.exec(html)) !== null) {
    const tableHtml = tbl[1];

    /* Caption tells us field / constructor / method */
    const caption = firstMatch(tableHtml, /<caption>([\s\S]*?)<\/caption>/).toLowerCase();
    let memberType = 'method';
    if      (caption.includes('field'))       memberType = 'field';
    else if (caption.includes('constr'))      memberType = 'constructor';

    /* One row per member */
    const rowRx = /<tr[^>]*class="(?:altColor|rowColor)"[^>]*>([\s\S]*?)<\/tr>/g;
    let row;
    while ((row = rowRx.exec(tableHtml)) !== null) {
      const rowHtml = row[1];

      const returnType = firstMatch(rowHtml, /class="colFirst"[^>]*>([\s\S]*?)<\/td>/);

      /* Member name from the <a> inside memberNameLink */
      const nameM = rowHtml.match(/class="memberNameLink"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
      const name  = nameM ? nameM[1].trim() : '';
      if (!name) continue;

      /* Full signature from colLast <code> */
      const sigM      = rowHtml.match(/class="colLast"[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>/);
      const signature = sigM ? stripTags(sigM[1]).trim() : name;

      /* Description from first .block inside colLast */
      const descM = rowHtml.match(/class="colLast"[\s\S]*?class="block"[^>]*>([\s\S]*?)<\/div>/);
      const desc  = descM ? stripTags(descM[1]).slice(0, 400) : '';

      members.push({
        class_name:           ref.name,
        qualified_class_name: qualifiedName,
        member_type:          memberType,
        name,
        signature,
        return_type: returnType,
        summary:     desc,
      });
    }
  }

  return { cls, members };
}

/* ── Database setup ─────────────────────────────────────────────────────── */

async function setupTables(client) {
  await client.query('DROP TABLE IF EXISTS javadoc_members');
  await client.query('DROP TABLE IF EXISTS javadoc_classes');

  await client.query(`
    CREATE TABLE javadoc_classes (
      id             SERIAL PRIMARY KEY,
      class_name     TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      package_name   TEXT,
      class_type     TEXT DEFAULT 'class',
      summary        TEXT,
      search_vec     tsvector
    )
  `);
  await client.query(`
    CREATE TABLE javadoc_members (
      id                   SERIAL PRIMARY KEY,
      class_id             INTEGER,
      class_name           TEXT NOT NULL,
      qualified_class_name TEXT NOT NULL,
      member_type          TEXT NOT NULL,   -- method | field | constructor
      name                 TEXT NOT NULL,
      signature            TEXT,
      return_type          TEXT,
      summary              TEXT,
      search_vec           tsvector
    )
  `);
  await client.query('CREATE INDEX ON javadoc_classes USING GIN(search_vec)');
  await client.query('CREATE INDEX ON javadoc_members  USING GIN(search_vec)');
  await client.query('CREATE INDEX ON javadoc_classes(lower(class_name))');
  await client.query('CREATE INDEX ON javadoc_members(lower(name))');
  console.log('Tables created.');
}

/* ── Batch insert ───────────────────────────────────────────────────────── */

async function insertClasses(client, classes) {
  const classIds = {};
  for (const cls of classes) {
    const r = await client.query(`
      INSERT INTO javadoc_classes (class_name, qualified_name, package_name, class_type, summary)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id
    `, [cls.class_name, cls.qualified_name, cls.package_name, cls.class_type, cls.summary]);
    classIds[cls.qualified_name] = r.rows[0].id;
  }
  return classIds;
}

async function insertMembers(client, members, classIds) {
  const BATCH = 200;
  for (let i = 0; i < members.length; i += BATCH) {
    const batch  = members.slice(i, i + BATCH);
    const tuples = [];
    const params = [];
    let   p      = 1;
    for (const m of batch) {
      tuples.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7})`);
      params.push(
        classIds[m.qualified_class_name] || null,
        m.class_name, m.qualified_class_name,
        m.member_type, m.name, m.signature, m.return_type, m.summary
      );
      p += 8;
    }
    await client.query(`
      INSERT INTO javadoc_members
        (class_id, class_name, qualified_class_name, member_type, name, signature, return_type, summary)
      VALUES ${tuples.join(',')}
    `, params);
  }
}

async function updateSearchVectors(client) {
  await client.query(`
    UPDATE javadoc_classes SET search_vec = to_tsvector('english',
      coalesce(class_name,'')     || ' ' ||
      coalesce(qualified_name,'') || ' ' ||
      coalesce(package_name,'')   || ' ' ||
      coalesce(summary,'')
    )
  `);
  await client.query(`
    UPDATE javadoc_members SET search_vec = to_tsvector('english',
      coalesce(name,'')       || ' ' ||
      coalesce(class_name,'') || ' ' ||
      coalesce(signature,'')  || ' ' ||
      coalesce(summary,'')
    )
  `);
  console.log('Search vectors updated.');
}

/* ── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`\nJavaDoc Ingestor`);
  console.log(`Source : ${JAVADOC_DIR}`);
  console.log(`DB     : ${(process.env.DATABASE_URL || '').slice(0, 40)}…\n`);

  const classRefs = parseAllClasses(JAVADOC_DIR);
  console.log(`Found   ${classRefs.length} entries in allclasses-noframe.html`);

  const allClasses = [];
  const allMembers = [];
  let   skipped    = 0;

  for (const ref of classRefs) {
    const filePath = path.join(JAVADOC_DIR, ref.filePath);
    if (!fs.existsSync(filePath)) { skipped++; continue; }

    const html            = fs.readFileSync(filePath, 'utf8');
    const { cls, members} = parseClassHtml(html, ref);
    allClasses.push(cls);
    allMembers.push(...members);
  }

  console.log(`Parsed  ${allClasses.length} classes, ${allMembers.length} members (${skipped} skipped)\n`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setupTables(client);
    process.stdout.write(`Inserting classes… `);
    const classIds = await insertClasses(client, allClasses);
    console.log('done');
    process.stdout.write(`Inserting members… `);
    await insertMembers(client, allMembers, classIds);
    console.log('done');
    process.stdout.write(`Updating FTS vectors… `);
    await updateSearchVectors(client);
    await client.query('COMMIT');
    console.log(`\n✓ Ingestion complete — ${allClasses.length} classes, ${allMembers.length} members.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Rolled back due to error:', e.message);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
