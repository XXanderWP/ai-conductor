/**
 * Image input helpers for vision-capable models.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImageContentPart, ImageDetail, ImageInput } from './types.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function isUrlLike(value: string): boolean {
  return /^(https?:|data:)/i.test(value);
}

function bytesToBase64(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Guess an image MIME type from a file path extension. */
export function imageMimeTypeFromPath(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

/**
 * Convert an {@link ImageInput} into an OpenAI-compatible `image_url` content part.
 * Local file paths are read from disk and inlined as `data:` URLs.
 */
export async function toImageContentPart(
  input: ImageInput,
  defaultDetail?: ImageDetail,
): Promise<ImageContentPart> {
  let url: string;
  let detail: ImageDetail | undefined = defaultDetail;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('Image input must be a non-empty URL, data URL, or file path.');
    }
    if (isUrlLike(trimmed)) {
      url = trimmed;
    } else {
      const mimeType = imageMimeTypeFromPath(trimmed);
      if (!mimeType) {
        throw new Error(
          `Cannot detect image type for "${trimmed}". Use one of: ${Object.keys(MIME_BY_EXTENSION).join(', ')}, or pass { data, mimeType }.`,
        );
      }
      const bytes = await readFile(trimmed);
      url = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
    }
  } else if ('url' in input) {
    if (!input.url?.trim()) throw new Error('Image input "url" must be a non-empty string.');
    url = input.url.trim();
    detail = input.detail ?? detail;
  } else {
    if (!input.mimeType?.trim()) throw new Error('Image input "mimeType" is required with data.');
    const base64 =
      typeof input.data === 'string' ? input.data.replace(/\s+/g, '') : bytesToBase64(input.data);
    if (!base64) throw new Error('Image input "data" must not be empty.');
    url = `data:${input.mimeType.trim()};base64,${base64}`;
    detail = input.detail ?? detail;
  }

  return {
    type: 'image_url',
    image_url: detail ? { url, detail } : { url },
  };
}
