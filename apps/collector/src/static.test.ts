import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStaticServer, type StaticServer } from './static.js';

interface Captured {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer;
}

/** Minimal stand-in for ServerResponse — the handler only writes a head and a body. */
function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, string | number>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(body?: Buffer) {
      if (body) captured.body = body;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

let root: string;
let outside: string;
let serve: StaticServer;

beforeAll(async () => {
  // The traversal tests need a real file that exists *above* the served root,
  // otherwise a 404 would prove nothing — it could just be a missing file.
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'solwz-static-'));
  root = path.join(outside, 'dist');

  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'models'), { recursive: true });

  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html>root');
  await fs.writeFile(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  await fs.writeFile(path.join(root, 'assets', 'app-abc123.css'), 'body{}');
  await fs.writeFile(path.join(root, 'models', 'orc.glb'), 'glTF-ish');
  await fs.writeFile(path.join(root, 'models', 'index.html'), 'models index');
  await fs.writeFile(path.join(root, 'unknown.xyzzy'), 'mystery');

  serve = createStaticServer(root);
});

afterAll(async () => {
  await fs.rm(outside, { recursive: true, force: true });
});

const get = async (urlPath: string) => {
  const { res, captured } = fakeResponse();
  const served = await serve(urlPath, res);
  return { served, ...captured };
};

describe('path containment', () => {
  // Each of these decodes to something above the served root. A hit would leak
  // repo files — package.json, .env, source — straight out of the container.
  const escapes = [
    '/../secret.txt',
    '/../../secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/assets/../../secret.txt',
    '/..%2fsecret.txt',
    '/%2E%2E/secret.txt',
    '/./../secret.txt',
  ];

  it.each(escapes)('refuses to serve %s', async (urlPath) => {
    const result = await get(urlPath);
    expect(result.served).toBe(false);
    expect(result.body.toString()).not.toContain('TOP SECRET');
  });

  it('still serves a path that merely contains dots', async () => {
    const result = await get('/assets/app-abc123.js');
    expect(result.served).toBe(true);
    expect(result.status).toBe(200);
  });

  it('does not confuse a sibling directory sharing the root prefix', async () => {
    // `dist-secret` starts with the same string as `dist`; a naive prefix check
    // without the separator would let it through.
    const sibling = path.join(outside, 'dist-secret');
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'leak.txt'), 'TOP SECRET');

    const result = await get('/../dist-secret/leak.txt');
    expect(result.served).toBe(false);
  });
});

describe('resolution', () => {
  it('maps / to index.html', async () => {
    const result = await get('/');
    expect(result.served).toBe(true);
    expect(result.body.toString()).toBe('<!doctype html>root');
  });

  it('maps a directory to its index.html', async () => {
    const result = await get('/models');
    expect(result.served).toBe(true);
    expect(result.body.toString()).toBe('models index');
  });

  it('strips the query string', async () => {
    const result = await get('/assets/app-abc123.js?v=deadbeef');
    expect(result.served).toBe(true);
    expect(result.body.toString()).toBe('console.log(1)');
  });

  it('reports a miss instead of throwing', async () => {
    await expect(get('/nope.js')).resolves.toMatchObject({ served: false });
  });

  it('reports a miss for a directory with no index', async () => {
    await fs.mkdir(path.join(root, 'empty'), { recursive: true });
    const result = await get('/empty');
    expect(result.served).toBe(false);
  });
});

describe('headers', () => {
  it('sets content-length from the body, not the string length', async () => {
    const result = await get('/models/orc.glb');
    expect(result.headers['content-length']).toBe(result.body.byteLength);
  });

  it.each([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/assets/app-abc123.js', 'text/javascript; charset=utf-8'],
    ['/assets/app-abc123.css', 'text/css; charset=utf-8'],
    ['/models/orc.glb', 'model/gltf-binary'],
    ['/unknown.xyzzy', 'application/octet-stream'],
  ])('types %s as %s', async (urlPath, expected) => {
    const result = await get(urlPath);
    expect(result.headers['content-type']).toBe(expected);
  });

  it('caches fingerprinted assets immutably', async () => {
    const result = await get('/assets/app-abc123.js');
    expect(result.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('makes everything else revalidate', async () => {
    // index.html is the entry point; caching it would pin users to an old build.
    for (const urlPath of ['/', '/index.html', '/models/orc.glb']) {
      const result = await get(urlPath);
      expect(result.headers['cache-control']).toBe(
        'public, max-age=0, must-revalidate',
      );
    }
  });
});
