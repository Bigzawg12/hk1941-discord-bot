import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { UserFacingError } from '../util/errors.js';
import { MAX_IMAGE_BYTES } from './render.js';

/** A picture to send with a message: a URL (Discord downloads it again) or a file on disk. */
export interface ImageFile {
  attachment: string;
  name: string;
}

const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function imageExt(contentType: string | null | undefined, fileName?: string | null): string | null {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (TYPES[t]) return TYPES[t]!;
  const m = /\.(png|jpe?g|gif|webp)$/i.exec(fileName ?? '');
  if (!m) return null;
  const e = m[1]!.toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

/** Check an uploaded picture (slash-command attachment) and name it for re-upload. */
export function imageFromAttachment(
  att: { url: string; name?: string | null; contentType?: string | null; size?: number } | null | undefined,
  baseName: string,
): ImageFile | undefined {
  if (!att) return undefined;
  const ext = imageExt(att.contentType, att.name);
  if (!ext) throw new UserFacingError('The picture has to be a PNG, JPG, GIF or WebP.');
  if ((att.size ?? 0) > MAX_IMAGE_BYTES) throw new UserFacingError(`The picture is too big (${Math.round((att.size ?? 0) / 1e6)} MB). Keep it under 8 MB.`);
  return { attachment: att.url, name: `${baseName}.${ext}` };
}

/**
 * Save a server's SSU banner to DATA_DIR/banners/<guildId>.<ext>, so it never depends on an
 * upload link that expires. Returns the path relative to DATA_DIR.
 */
export async function saveBanner(
  dataDir: string,
  guildId: string,
  image: ImageFile,
  fetchImpl: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<string> {
  const res = await fetchImpl(image.attachment);
  if (!res.ok) throw new UserFacingError(`Couldn't download the picture from Discord (HTTP ${res.status}). Try again.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new UserFacingError('The picture is too big. Keep it under 8 MB.');
  const dir = join(dataDir, 'banners');
  await mkdir(dir, { recursive: true });
  await removeBanner(dataDir, guildId);
  const ext = image.name.split('.').pop() ?? 'png';
  const rel = join('banners', `${guildId}.${ext}`);
  await writeFile(join(dataDir, rel), buf);
  return rel;
}

export async function removeBanner(dataDir: string, guildId: string): Promise<void> {
  const dir = join(dataDir, 'banners');
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter((n) => n.startsWith(`${guildId}.`)).map((n) => rm(join(dir, n), { force: true })));
}

/** The saved banner as a file to send, or undefined. */
export function bannerFile(dataDir: string, rel: string | undefined): ImageFile | undefined {
  if (!rel) return undefined;
  const ext = rel.split('.').pop() ?? 'png';
  return { attachment: resolve(dataDir, rel), name: `ssu-banner.${ext}` };
}
