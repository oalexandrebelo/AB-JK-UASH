import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {access} from 'node:fs/promises';
import {createApplication} from '../server/application.mjs';
import {normalizePublicOrigins} from '../server/http.mjs';
import {readSetupToken} from './bootstrap-token.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export async function startupConfiguration(env = process.env, projectRoot = root) {
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve estar entre 1 e 65535.');
  const host = env.HOST || '127.0.0.1';
  const external = !LOOPBACK.has(host);
  if (external && !env.PUBLIC_ORIGIN) throw new Error('Para acesso em rede, configure PUBLIC_ORIGIN explicitamente.');
  const publicOrigin = env.PUBLIC_ORIGIN === undefined ? undefined : normalizePublicOrigins(env.PUBLIC_ORIGIN.split(',').map(value => value.trim()));
  const setupToken = await readSetupToken({setupToken: env.SETUP_TOKEN, setupTokenFile: env.SETUP_TOKEN_FILE, required: external, createIfMissing: true});
  return {port, host, options: {
    dbPath: resolve(env.DB_PATH || resolve(projectRoot, 'data/ab-uash.sqlite')),
    distDir: resolve(env.DIST_DIR || resolve(projectRoot, 'dist')),
    databaseUrl: env.DATABASE_URL,
    databaseSchema: env.DATABASE_SCHEMA || 'ab_uash',
    databaseCa: env.DATABASE_CA,
    databasePoolSize: Number(env.DATABASE_POOL_SIZE || 1),
    setupToken,
    publicOrigin,
    secureCookies: env.COOKIE_SECURE === 'true',
  }};
}

export async function start({openBrowser = process.argv.includes('--open'), requireFrontend = true} = {}) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use o Node.js 24 incluído em uma distribuição completa ou uma instalação local compatível.');
  const {port, host, options} = await startupConfiguration();
  if (requireFrontend) await access(resolve(options.distDir, 'index.html'));
  const app = await createApplication(options);
  try { await app.listen({port, host}); } catch (error) { await app.close(); throw error; }
  const address = options.publicOrigin?.[0] || `http://${host === '::1' ? '[::1]' : host}:${port}`;
  console.log(`\nAB-UASH • ${app.store.mode === 'postgres' ? 'PostgreSQL' : 'Operação local'}\n${address}\n\nMantenha esta janela aberta. Para encerrar, pressione Ctrl+C.\n`);
  if (openBrowser && LOOPBACK.has(host)) {
    const command = process.platform === 'darwin' ? ['open', [address]] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', address]] : ['xdg-open', [address]];
    const opener = spawn(command[0], command[1], {stdio: 'ignore', detached: true});
    opener.on('error', () => console.log(`Abra manualmente ${address}`));
    opener.unref();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    try { await app.close(); process.exitCode = 0; }
    catch { console.error('Não foi possível encerrar o armazenamento corretamente.'); process.exitCode = 1; }
  });
  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await start();
