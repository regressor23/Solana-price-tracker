import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** Vite fingerprints everything under /assets, so it is safe to cache hard. */
const cacheControl = (urlPath: string): string =>
  urlPath.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=0, must-revalidate';

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes the root
 * or does not exist.
 */
async function resolveFile(root: string, urlPath: string): Promise<string | null> {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative);

  // path.resolve collapses `..`, so a prefix check is enough to contain it.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;

  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) return resolveFile(root, `${decoded}/index.html`);
    return candidate;
  } catch {
    return null;
  }
}

export interface StaticServer {
  (urlPath: string, res: ServerResponse): Promise<boolean>;
}

export function createStaticServer(root: string): StaticServer {
  const resolvedRoot = path.resolve(root);

  return async (urlPath, res) => {
    const file = await resolveFile(resolvedRoot, urlPath);
    if (file === null) return false;

    const body = await fs.readFile(file);
    res.writeHead(200, {
      'content-type':
        MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'cache-control': cacheControl(urlPath),
    });
    res.end(body);
    return true;
  };
}
