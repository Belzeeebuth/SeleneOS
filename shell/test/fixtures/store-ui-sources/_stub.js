'use strict';
// Tiny deterministic stand-ins for shell/main/lib/sources/{ubuntu,flathub}.js, used by test/store.test.mjs
// through AURORA_STORE_SOURCES_DIR (dev only). They follow docs/STORE-SOURCES.md: search / details / installed /
// install / remove / refresh / status. Icons are inline SVG data URLs. Env knobs:
//   AURORA_STORE_DEV_FAIL=<id>          install of <id> fails
//   AURORA_STORE_STUB_OFFLINE=<source>  refresh of that source fails with ENETWORK
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function iconFor(name, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="4" y="4" width="56" height="56" rx="14" fill="${color}"/><text x="32" y="42" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${name[0]}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
module.exports = function makeStub(id, label, apps, { installed = [] } = {}) {
  const state = { installed: new Map(installed.map((i) => [i, '1.0'])), updatedAt: Date.now() - 3600 * 1000, ctx: null };
  const colors = ['#d9534f', '#2d7dd2', '#3fa34d', '#8e44ad', '#e67e22', '#16a085', '#c0392b', '#34495e'];
  const items = apps.map((a, i) => ({
    source: id,
    id: a.id,
    appId: a.appId || null,
    name: a.name,
    summary: a.summary,
    icon: a.noIcon ? null : iconFor(a.name, colors[i % colors.length]),
    categories: a.categories,
    desktopId: a.desktopId || (a.appId ? `${a.appId}.desktop` : `${a.id}.desktop`),
  }));
  const fr = () => state.ctx?.env?.lang === 'fr';
  const view = (it) => ({ ...it, summary: fr() && apps.find((a) => a.id === it.id)?.summaryFr ? apps.find((a) => a.id === it.id).summaryFr : it.summary, installed: state.installed.has(it.id) });
  async function progress(onProgress, n = 5) {
    for (let k = 1; k <= n; k++) {
      await sleep(120);
      onProgress?.({ percent: Math.round((k / n) * 100), message: `step ${k}/${n}` });
    }
  }
  return {
    id,
    label: { en: label, fr: label },
    init(ctx) {
      state.ctx = ctx;
    },
    async status() {
      return { available: true, ready: true, updatedAt: state.updatedAt, count: items.length };
    },
    async refresh(onProgress) {
      onProgress?.({ phase: 'download', percent: 30 });
      await sleep(150);
      if (process.env.AURORA_STORE_STUB_OFFLINE === id) {
        const e = new Error('Could not reach the server: no network connection');
        e.code = 'ENETWORK';
        throw e;
      }
      onProgress?.({ phase: 'parse', percent: 80 });
      await sleep(150);
      state.updatedAt = Date.now();
      return { count: items.length };
    },
    async search({ query = '', category = '', offset = 0, limit = 60 } = {}) {
      const q = String(query).toLowerCase().trim();
      let list = items.filter((it) => (!category || it.categories.includes(category)) && (!q || `${it.name} ${it.summary} ${it.id}`.toLowerCase().includes(q)));
      list = list.sort((a, b) => a.name.localeCompare(b.name));
      return { items: list.slice(offset, offset + Math.min(limit, 60)).map(view), total: list.length };
    },
    async details(appid) {
      const it = items.find((i) => i.id === appid);
      if (!it) throw Object.assign(new Error(`unknown app ${appid}`), { code: 'ENOENT' });
      const a = apps.find((x) => x.id === appid);
      return {
        ...view(it),
        description: `${a.name} — ${a.summary}.\n\nThis is a test fixture of the ${label} source.`,
        screenshots: ['https://example.invalid/shot1.png', 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#5b8def"/></svg>').toString('base64')],
        homepage: `https://example.org/${appid}`,
        license: 'GPL-3.0-or-later',
        developer: a.developer || 'The Example Project',
        version: '1.2.3',
        downloadSize: a.size || 52428800,
      };
    },
    async installed() {
      return [...state.installed].map(([i, version]) => ({ id: i, version }));
    },
    async install(appid, onProgress) {
      if (!items.some((i) => i.id === appid)) throw Object.assign(new Error(`unknown app ${appid}`), { code: 'ENOENT' });
      await progress(onProgress, 3);
      if (process.env.AURORA_STORE_DEV_FAIL === appid) throw Object.assign(new Error(`could not install ${appid}: remote error`), { code: 'ECMD' });
      await progress(onProgress, 2);
      state.installed.set(appid, '1.2.3');
      return { desktopId: items.find((i) => i.id === appid).desktopId };
    },
    async remove(appid, onProgress) {
      await progress(onProgress, 2);
      state.installed.delete(appid);
      return {};
    },
  };
};
