// Reused from AB-UASH main: server/integrations/secrets.ts. See integrations/jk/PROVENANCE.md.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
export class SecretFileError extends Error {
    code;
    constructor(code){
        super(code);
        this.name = 'SecretFileError';
        this.code = code;
    }
}
export async function readPrivateFile(root, file, maxBytes = 1024 * 1024) {
    if (!file || isAbsolute(file) || file.includes('\0') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new SecretFileError('INVALID_SECRET_REFERENCE');
    let canonicalRoot;
    try {
        canonicalRoot = await realpath(root);
    } catch  {
        throw new SecretFileError('SECRET_ROOT_UNAVAILABLE');
    }
    const candidate = resolve(canonicalRoot, file);
    const relation = relative(canonicalRoot, candidate);
    if (relation.startsWith('..') || isAbsolute(relation) || !relation) throw new SecretFileError('SECRET_PATH_FORBIDDEN');
    let actual;
    try {
        actual = await realpath(candidate);
    } catch  {
        throw new SecretFileError('SECRET_FILE_UNAVAILABLE');
    }
    if (actual !== candidate) throw new SecretFileError('SECRET_SYMLINK_FORBIDDEN');
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(()=>{
        throw new SecretFileError('SECRET_FILE_UNAVAILABLE');
    });
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new SecretFileError('SECRET_FILE_SIZE_OR_TYPE');
        if (process.platform !== 'win32' && (info.mode & 0o027) !== 0) throw new SecretFileError('SECRET_FILE_PERMISSIONS');
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while(length < buffer.length){
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > maxBytes) throw new SecretFileError('SECRET_FILE_SIZE_OR_TYPE');
        return buffer.subarray(0, length);
    } finally{
        await handle.close();
    }
}
export async function readPrivateText(root, file, maxBytes = 16 * 1024) {
    const data = await readPrivateFile(root, file, maxBytes);
    let text;
    try {
        text = new TextDecoder('utf-8', {
            fatal: true
        }).decode(data);
    } catch  {
        throw new SecretFileError('SECRET_ENCODING');
    }
    text = text.replace(/\r?\n$/, '');
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw new SecretFileError('SECRET_FORMAT');
    return text;
}
