import { constants } from 'node:fs';
import { mkdir, open, unlink, readdir, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const IMAGE_DIRECTORY = '/workspace/.codex-terminal/uploads';
const formats = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const failure = (status, message) => Object.assign(Error(message), { status });

export function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Pin each directory with a descriptor. Neither parent symlinks nor a directory
// replacement between checking and writing can redirect the upload on Linux.
async function uploadDirectory(directory, create = true) {
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of resolve(directory).split('/').filter(Boolean)) {
      const path = `/proc/self/fd/${handle.fd}/${part}`;
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const next = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

const storedName = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|webp)$/;
const storageOperations = new Map();
// Listing/deletion must never see or unlink a file while an upload is writing.
async function withStorage(directory, operation) {
  const key = resolve(directory);
  const previous = storageOperations.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  storageOperations.set(key, current);
  try { return await current; }
  finally { if (storageOperations.get(key) === current) storageOperations.delete(key); }
}

export async function listImages({ directory = IMAGE_DIRECTORY } = {}) {
  return withStorage(directory, async () => {
    let folder;
    try {
      folder = await uploadDirectory(directory, false);
      const images = [];
      for (const name of (await readdir(`/proc/self/fd/${folder.fd}`)).sort()) {
        if (!storedName.test(name)) continue;
        let file;
        try {
          file = await open(`/proc/self/fd/${folder.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const info = await file.stat();
          if (info.isFile()) images.push({ path: join(resolve(directory), name), mimeType: { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[name.split('.').pop()], size: info.size });
        } catch (error) { if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error; }
        finally { await file?.close().catch(() => {}); }
      }
      return { images };
    } catch (error) {
      if (error.code === 'ENOENT') return { images: [] };
      throw failure(503, 'Unable to list saved images. Check workspace storage and retry.');
    } finally { await folder?.close().catch(() => {}); }
  });
}

export async function deleteImages({ directory = IMAGE_DIRECTORY, name } = {}) {
  if (name !== undefined && !storedName.test(name)) throw failure(400, 'Invalid image filename.');
  return withStorage(directory, async () => {
    let folder;
    let deleted = 0;
    try {
      folder = await uploadDirectory(directory, false);
      const names = name === undefined ? await readdir(`/proc/self/fd/${folder.fd}`) : [name];
      for (const candidate of names) {
        if (!storedName.test(candidate)) continue;
        const target = `/proc/self/fd/${folder.fd}/${candidate}`;
        try {
          if (!(await lstat(target)).isFile()) continue;
          await unlink(target);
          deleted++;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure(503, 'Unable to delete saved images. Some images may already have been removed. Refresh the list and retry.');
    } finally { await folder?.close().catch(() => {}); }
    if (name !== undefined && !deleted) throw failure(404, 'This saved image no longer exists. Refresh the list.');
    return { deleted };
  });
}

export async function saveImage(req, { directory = IMAGE_DIRECTORY, disconnected = () => req.aborted } = {}) {
  const declared = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (!Object.hasOwn(formats, declared)) throw failure(415, 'Choose PNG, JPEG or WebP. Export HEIC/HEIF as JPEG, or use a screenshot.');
  if (Number(req.headers['content-length']) > IMAGE_LIMIT) throw failure(413, 'Each image must be 10 MiB or smaller.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > IMAGE_LIMIT) throw failure(413, 'Each image must be 10 MiB or smaller.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const mimeType = imageType(bytes);
  if (!size || !mimeType || mimeType !== declared) throw failure(415, 'The image is empty, unsupported, or does not match its declared format. Choose PNG, JPEG or WebP.');
  return withStorage(directory, async () => {
    let folder, file, target, created = false, completed = false;
    try {
      folder = await uploadDirectory(directory);
      const name = `${randomUUID()}.${formats[mimeType]}`;
      target = `/proc/self/fd/${folder.fd}/${name}`;
      file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      if (disconnected()) throw Error('Disconnected');
      await file.writeFile(bytes);
      await file.close(); file = null;
      if (disconnected()) throw Error('Disconnected');
      completed = true;
      return { path: join(resolve(directory), name), mimeType, size };
    } catch {
      throw failure(503, 'Unable to save the image in the workspace. Check storage and retry.');
    } finally {
      await file?.close().catch(() => {});
      if (created && !completed) await unlink(target).catch(() => {});
      await folder?.close().catch(() => {});
    }
  });
}
