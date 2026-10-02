/*
 * Draws the app icons in public/icons/ from one SVG: the ticket from the site header on the
 * brand gradient. Run it again after changing the design: npx tsx scripts/make-icons.ts
 *
 *   icon.svg               favicon (scales to any size)
 *   icon-192.png, -512     the installed app's icon (Android, desktop Chrome and Edge)
 *   maskable-512.png       full-bleed version that Android crops to circles, squircles, …
 *   apple-touch-icon.png   home-screen icon on iPhone and iPad (iOS rounds the corners itself)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const TICKET =
  '<path d="M3 9a3 3 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a3 3 0 0 0 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z"/>' +
  '<path d="M13 5v2M13 11v2M13 17v2"/>';

/**
 * corner: radius of the background (0 = square, for icons the OS masks itself).
 * glyph: how wide the 24-unit ticket glyph is drawn, in a 512 box. A maskable icon keeps it
 * inside the central safe zone, a circle 80% of the icon's width.
 */
const svg = ({ corner, glyph }: { corner: number; glyph: number }) => {
  const scale = glyph / 24;
  const offset = (512 - glyph) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
  <rect width="512" height="512" rx="${corner}" fill="url(#g)"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TICKET}</g>
</svg>
`;
};

const rounded = svg({ corner: 112, glyph: 320 });
const fullBleed = svg({ corner: 0, glyph: 264 });

await mkdir('public/icons', { recursive: true });
await writeFile('public/icons/icon.svg', rounded);
const png = (source: string, size: number, file: string) =>
  sharp(Buffer.from(source)).resize(size, size).png({ compressionLevel: 9 }).toFile(`public/icons/${file}`);
await Promise.all([
  png(rounded, 192, 'icon-192.png'),
  png(rounded, 512, 'icon-512.png'),
  png(fullBleed, 512, 'maskable-512.png'),
  png(fullBleed, 180, 'apple-touch-icon.png'),
]);
console.log(
  'Wrote public/icons/: icon.svg, icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png',
);
