import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/** Serves a built SPA from `dist` with index.html fallback. Read-only; never serves anything outside `dist` (traversal and symlinks checked). */
export async function createStatic(dist: string) {
  const root = await realpath(resolve(dist));

  const inside = async (p: string) => {
    try {
      const real = await realpath(p);
      return real.startsWith(root + sep) && (await stat(real)).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  };

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end();
      return true;
    }
    if (rel.includes('\0')) {
      res.writeHead(400).end();
      return true;
    }
    const wanted = resolve(join(root, rel.replace(/\\/g, '/')));
    let file = wanted.startsWith(root + sep) ? await inside(wanted) : undefined;
    if (!file && extname(rel) === '') file = await inside(join(root, 'index.html')); // SPA fallback only for extension-less routes
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return true;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  };
}
