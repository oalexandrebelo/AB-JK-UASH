import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createApplication as application } from '../server/application.mjs';

const schemas = new Map();
let administrator;
async function adminClient() {
  if (administrator) return administrator;
  const url = new URL(process.env.AB_UASH_TEST_DATABASE_URL);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Use somente PostgreSQL local isolado nos testes.');
  const pg = await import('pg');
  administrator = new pg.Client({connectionString: url.href});
  await administrator.connect();
  return administrator;
}
export {adminClient as testDatabaseAdministrator};
export async function createTestApplication(options = {}) {
  if (!process.env.AB_UASH_TEST_DATABASE_URL || options.databaseUrl) return application(options);
  let schema = schemas.get(options.dbPath);
  if (!schema) {
    schema = `ab_uash_test_${randomUUID().replaceAll('-', '')}`;
    const client = await adminClient();
    const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = (await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')).replace(/\bab_uash\b/gu, schema);
      try { await client.query(sql); } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    schemas.set(options.dbPath, schema);
  }
  const runtime = new URL(process.env.AB_UASH_TEST_DATABASE_URL);
  runtime.username = 'ab_uash_app'; runtime.password = '';
  return application({...options,databaseUrl: runtime.href,databaseSchema: schema});
}
after(async () => {
  if (!administrator) return;
  for (const schema of schemas.values()) await administrator.query(`DROP SCHEMA "${schema}" CASCADE`);
  await administrator.end();
});
