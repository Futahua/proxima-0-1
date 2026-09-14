// Applies the schema to a throwaway in-memory database and lists what it made.
// Run: node service/check-schema.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
console.log('tables:', tables.join(', '));
console.log('indexes:', indexes.join(', '));
console.log('count:', tables.length, 'tables');
db.close();
