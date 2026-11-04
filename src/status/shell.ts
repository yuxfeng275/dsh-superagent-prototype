/**
 * Public shell of the read-only `/status` app: the HTML document, stylesheet, web app manifest, service worker and
 * generated icons. Everything here is static and carries no data; the app reads data only from the authenticated
 * `/status/api` routes. The browser bundle is built separately to `lib/status-app.js`.
 */
import { deflateSync } from 'node:zlib'

const COLORS = {
  light: { bg: '#f6f7f9', surface: '#ffffff', text: '#111827', muted: '#6b7280', border: '#e5e7eb', accent: '#2563eb' },
  dark: { bg: '#0b1020', surface: '#121a2b', text: '#e5e7eb', muted: '#94a3b8', border: '#22304a', accent: '#60a5fa' },
}
/** Stylesheet of the standalone app: one column on phones, two columns from tablet width, light and dark. */
export const STYLES = `
:root { color-scheme: light dark; --bg: ${COLORS.light.bg}; --surface: ${COLORS.light.surface}; --text: ${COLORS.light.text};
  --muted: ${COLORS.light.muted}; --border: ${COLORS.light.border}; --accent: ${COLORS.light.accent}; --ok: #059669; --warn: #b45309; --error: #dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg: ${COLORS.dark.bg}; --surface: ${COLORS.dark.surface}; --text: ${COLORS.dark.text};
  --muted: ${COLORS.dark.muted}; --border: ${COLORS.dark.border}; --accent: ${COLORS.dark.accent}; --ok: #34d399; --warn: #fbbf24; --error: #f87171; } }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-text-size-adjust: 100%; padding-bottom: calc(64px + env(safe-area-inset-bottom)); }
a { color: var(--accent); text-decoration: none; }
a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button { font: inherit; color: inherit; min-height: 44px; min-width: 44px; padding: 8px 14px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .55; cursor: default; }
input { font: inherit; color: inherit; min-height: 44px; width: 100%; padding: 8px 12px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface); }
h1, h2, h3 { margin: 0; line-height: 1.3; }
h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 15px; }
.top { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between;
  padding: calc(10px + env(safe-area-inset-top)) 16px 10px; background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.brand strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 52vw; }
.meta { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.ok { background: var(--ok); } .dot.attention { background: var(--warn); } .dot.offline { background: var(--error); }
.banner { margin: 12px 16px 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, var(--surface)); font-size: 14px; }
main { max-width: 1100px; margin: 0 auto; padding: 16px 16px 32px; }
.grid { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; min-width: 0; }
.card h2 { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.muted { color: var(--muted); } .small { font-size: 13px; } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.row { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
  color: inherit; background: none; text-align: left; width: 100%; }
a.row:hover, button.row:hover { border-color: var(--accent); }
.row-title { font-weight: 600; overflow-wrap: anywhere; }
.row-meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.tag.warn { color: var(--warn); border-color: var(--warn); } .tag.error { color: var(--error); border-color: var(--error); }
.tag.ok { color: var(--ok); border-color: var(--ok); }
.chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 12px; scrollbar-width: none; }
.chips::-webkit-scrollbar { display: none; }
.chip { flex: none; min-height: 40px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); }
.chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.metric { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
.metric b { display: block; font-size: 22px; line-height: 1.2; }
.metric span { color: var(--muted); font-size: 13px; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; }
.prose pre { white-space: pre-wrap; overflow-wrap: anywhere; background: color-mix(in srgb, var(--text) 6%, transparent); padding: 10px; border-radius: 8px; }
.prose code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.bottom { position: fixed; left: 0; right: 0; bottom: 0; z-index: 3; display: grid; grid-template-columns: repeat(4, 1fr);
  background: var(--surface); border-top: 1px solid var(--border); padding-bottom: env(safe-area-inset-bottom); }
.bottom a { display: flex; align-items: center; justify-content: center; min-height: 56px; color: var(--muted); font-size: 14px; }
.bottom a[aria-current="page"] { color: var(--accent); font-weight: 600; }
.empty { color: var(--muted); padding: 8px 2px; }
.error { color: var(--error); }
.hint { color: var(--muted); font-size: 14px; }
.pair { max-width: 420px; margin: 24px auto; }
.pair form { display: grid; gap: 12px; margin-top: 12px; }
.setup-url { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.setup-url .mono { overflow-wrap: anywhere; }
.device { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
@media (min-width: 700px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid .wide { grid-column: 1 / -1; }
  .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .top { padding: 12px 24px; }
  main { padding: 20px 24px 40px; }
  .bottom { position: sticky; bottom: 0; max-width: 1100px; margin: 0 auto; border: 1px solid var(--border);
    border-radius: 14px 14px 0 0; }
  body { padding-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
`
/** HTML document served for every app route; the app renders the current location into `#root`. */
export function shellHtml(language: 'zh' | 'en'): string {
  return `<!doctype html>
<html lang="${language === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1020" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="description" content="Read-only Superagent status for desktop and phone">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/status/manifest.webmanifest">
<link rel="apple-touch-icon" href="/status/icon-192.png">
<link rel="icon" href="/status/icon-192.png" type="image/png">
<title>Superagent</title>
<style>${STYLES}</style>
</head>
<body>
<div id="root"><p class="hint" style="padding:24px">正在加载…</p></div>
<noscript><p class="hint" style="padding:24px">此页面需要 JavaScript。This page needs JavaScript.</p></noscript>
<script type="module" src="/status/app.js"></script>
</body>
</html>`
}
/** Web app manifest; `start_url` and `scope` keep the installed app inside `/status/`. */
export function manifestJson(): string {
  return JSON.stringify({
    name: 'Superagent 状态', short_name: 'Superagent',
    description: '只读查看 Superagent 的运行情况 / Read-only Superagent status',
    start_url: '/status/', scope: '/status/', display: 'standalone', orientation: 'any',
    background_color: '#f6f7f9', theme_color: '#0f172a',
    icons: [
      { src: '/status/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/status/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/status/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)
}
/**
 * Service worker: precache the app shell so an installed app opens offline, network-first for everything under
 * `/status`, and network-only for `/status/api` (the app keeps its last snapshot in localStorage itself).
 */
export const SERVICE_WORKER = `const CACHE = 'dsh-superagent-status-v1'
const SHELL = ['/status/', '/status/app.js', '/status/manifest.webmanifest', '/status/icon-192.png', '/status/icon-512.png']
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/status')) return
  if (url.pathname.startsWith('/status/api/')) { event.respondWith(fetch(event.request)); return }
  // Network first, so a Host upgrade is picked up even when only the app bundle changed; the cache keeps it usable offline.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)) }
    return response
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/status/')))))
})`

const CRC = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()
function crc32(data: Buffer): number {
  let value = 0xffffffff
  for (const byte of data) value = CRC[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
/** Encode one RGBA image as a PNG. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y), at = y * (width * 4 + 1) + 1 + x * 4
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
/**
 * One app icon: a dark rounded tile with a blue status ring and a light centre dot. `maskable` keeps the artwork
 * inside the safe zone and fills the square, so Android and iOS masks never clip the ring.
 */
export function iconPng(size: number, maskable = false): Buffer {
  const center = (size - 1) / 2
  const background = (x: number, y: number): [number, number, number, number] => {
    if (!maskable) {
      const radius = size * 0.22, dx = Math.max(radius - x, x - (size - 1 - radius), 0)
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0)
      if (dx * dx + dy * dy > radius * radius) return [15, 23, 42, 0]
    }
    return [15, 23, 42, 255]
  }
  return png(size, size, (x, y) => {
    const dx = x - center, dy = y - center, distance = Math.sqrt(dx * dx + dy * dy)
    const ring = size * (maskable ? 0.27 : 0.31), dot = size * (maskable ? 0.1 : 0.12)
    if (distance <= dot) return [224, 242, 254, 255]
    if (distance <= ring) {
      const edge = Math.min(1, ring - distance)
      return [56, 189, 248, Math.round(255 * Math.min(1, edge * 2))]
    }
    return background(x, y)
  })
}
