import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const raw = readFileSync('.env', 'utf8');
let dsn = '';
for (const line of raw.split(/\r?\n/)) {
  const m = /^\s*PG_DSN\s*=\s*(.*)$/.exec(line);
  if (m) dsn = m[1].trim().replace(/^["']|["']$/g, '');
}
const sql = postgres(dsn, { max: 1 });
const queries = process.argv.slice(2);
if (queries.length === 0) {
  console.error('usage: node probe.mjs "SQL" ["SQL"...]');
  process.exit(2);
}
for (const q of queries) {
  console.log(`--- ${q}`);
  try {
    const rows = await sql.unsafe(q);
    for (const r of rows) console.log(JSON.stringify(r));
    console.log(`(${rows.length} rows)`);
  } catch (e) {
    console.log(`ERROR ${e.message}`);
  }
}
await sql.end();
