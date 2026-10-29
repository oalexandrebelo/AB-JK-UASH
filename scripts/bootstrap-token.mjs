import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/u;
const FILE_TOKEN = /^([A-Za-z0-9_-]{32,256})(?:\r?\n)?$/u;

function validateToken(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('SETUP_TOKEN deve ter 32 a 256 caracteres base64url.');
  return token;
}

async function readTokenFile(path) {
  let file;
  try {
    // O_NOFOLLOW prevents a secret path from redirecting reads to another file.
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await file.stat();
    if (!info.isFile() || info.size < 32 || info.size > 258) throw new Error('SETUP_TOKEN_FILE deve ser um arquivo regular contendo apenas o token.');
    if (process.platform !== 'win32' && ((info.mode & 0o7777) !== 0o600 || (process.getuid && info.uid !== process.getuid()))) {
      throw new Error('SETUP_TOKEN_FILE deve pertencer ao usuário do processo e ter permissão 0600.');
    }
    const token = FILE_TOKEN.exec(await file.readFile('utf8'))?.[1];
    if (!token) throw new Error('SETUP_TOKEN_FILE contém um token inválido.');
    return token;
  } finally {
    await file?.close();
  }
}

/** Creates a private, persistent token without returning or printing its value. */
export async function createSetupToken(path = '/data/setup-token') {
  if (typeof path !== 'string' || !path) throw new Error('Informe um caminho para SETUP_TOKEN_FILE.');
  const absolutePath = resolve(path);
  let file;
  try {
    file = await open(absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await readTokenFile(absolutePath);
    return {path: absolutePath, created: false};
  }
  try {
    await file.writeFile(`${randomBytes(48).toString('base64url')}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await readTokenFile(absolutePath);
  return {path: absolutePath, created: true};
}

/** Secret values remain in process memory; configuration errors never echo them. */
export async function readSetupToken({setupToken, setupTokenFile, required = false, createIfMissing = false} = {}) {
  if (setupToken !== undefined && setupTokenFile !== undefined) throw new Error('Configure somente SETUP_TOKEN ou SETUP_TOKEN_FILE.');
  if (setupToken !== undefined) return validateToken(setupToken);
  if (setupTokenFile !== undefined) {
    if (typeof setupTokenFile !== 'string' || !setupTokenFile) throw new Error('SETUP_TOKEN_FILE deve indicar um arquivo privado.');
    const path = resolve(setupTokenFile);
    if (createIfMissing) await createSetupToken(path);
    return readTokenFile(path);
  }
  if (required) throw new Error('Para acesso em rede, configure SETUP_TOKEN_FILE ou SETUP_TOKEN antes de iniciar.');
  return undefined;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--file')) throw new Error('Uso: node scripts/bootstrap-token.mjs [--file /data/setup-token]');
    const result = await createSetupToken(args[1] || process.env.SETUP_TOKEN_FILE || '/data/setup-token');
    console.log(result.created ? 'Arquivo privado de configuração criado (0600). O token não é exibido.' : 'Arquivo privado de configuração existente preservado. O token não é exibido.');
  } catch (error) {
    console.error(error.code ? 'Não foi possível preparar o arquivo privado de configuração. Verifique o diretório e suas permissões.' : error.message);
    process.exitCode = 1;
  }
}
