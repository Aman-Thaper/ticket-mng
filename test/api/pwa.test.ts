import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { useApp } from '../helpers.js';

/**
 * The installable app: guards against the easy mistakes. A file renamed without updating the
 * service worker's list, an icon that doesn't load, a page that forgot the manifest.
 */
describe('installable app (PWA)', () => {
  const t = useApp();

  it('serves every file the service worker saves at install', async () => {
    const sw = await readFile('public/sw.js', 'utf8');
    const list = /const PRECACHE = \[([^\]]+)\]/.exec(sw)?.[1];
    const paths = [...(list ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      const res = await t.app.inject({ url: path });
      expect(res.statusCode, path).toBe(200);
    }
  });

  it('has a manifest that browsers accept for installing', async () => {
    const res = await t.app.inject({ url: '/manifest.webmanifest' });
    expect(res.headers['content-type']).toContain('application/manifest+json');
    const manifest = res.json<{
      name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    }>();
    expect(manifest).toMatchObject({ name: 'Ticket MNG', start_url: '/', display: 'standalone' });
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      const image = await t.app.inject({ url: icon.src });
      expect(image.statusCode, icon.src).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
    }
  });

  it('links the manifest and icons from every page', async () => {
    const pages = (await readdir('public')).filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      const html = await readFile(`public/${page}`, 'utf8');
      expect(html, page).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
      expect(html, page).toContain('<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />');
      expect(html, page).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    }
  });

  it('keeps the API out of the service worker cache', async () => {
    const sw = await readFile('public/sw.js', 'utf8');
    const passThrough = new RegExp(/const PASS_THROUGH = \/(.+)\/;/.exec(sw)![1]!);
    for (const path of ['/api/v1/bookings', '/api', '/docs/json', '/metrics', '/health/ready']) {
      expect(passThrough.test(path), path).toBe(true);
    }
    for (const path of ['/', '/my-tickets', '/events/123', '/session.js', '/apis.html']) {
      expect(passThrough.test(path), path).toBe(false);
    }
  });
});
