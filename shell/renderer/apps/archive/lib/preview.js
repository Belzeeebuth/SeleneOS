// Preview pane (Explorer's preview + details panes in one): pictures and text files are extracted on demand
// to the window's private temp folder and shown inline; other items show their icon and properties.
import { iconUrl, typeName, previewKind, ratioOf, extOf } from './util.js';

const IMAGE_MAX = 40 * 1024 * 1024;
const TEXT_MAX = 16 * 1024 * 1024;
const TEXT_READ = 256 * 1024;

export class PreviewPane {
  constructor(w) {
    this.w = w;
    const { h } = w;
    this.token = 0;
    this.timer = null;
    this.el = h('aside', { class: 'arc-preview', 'aria-label': w.t('preview.label'), tabindex: '-1' });
  }

  update(nodes) {
    clearTimeout(this.timer);
    const tok = ++this.token;
    this.timer = setTimeout(() => this.render(nodes, tok), nodes.length === 1 && previewKind(nodes[0]) ? 140 : 0);
  }

  meta(rows) {
    const { h } = this.w;
    return h(
      'div',
      { class: 'arc-pv-meta' },
      rows.filter((r) => r && r[1] !== '' && r[1] != null).map(([k, v]) => h('div', { class: 'arc-pv-row' }, h('div', { class: 'arc-pv-k caption text-2' }, k), h('div', { class: 'arc-pv-v caption selectable' }, v))),
    );
  }

  render(nodes, tok) {
    if (tok !== this.token) return;
    const { h, t, i18n, icon, listing: L } = this.w;
    if (!L) return this.el.replaceChildren();
    const size = (n) => i18n.formatSize(n);
    const date = (ms) => (ms ? i18n.formatDate(ms, { dateStyle: 'medium', timeStyle: 'short' }) : '');
    if (nodes.length > 1) {
      const files = nodes.reduce((s, n) => s + (n.dir ? n.files : 1), 0);
      const total = nodes.reduce((s, n) => s + (n.dir ? n.tsize : n.size), 0);
      this.el.replaceChildren(
        h('div', { class: 'arc-pv-hero' }, h('div', { class: 'arc-pv-stack' }, nodes.slice(0, 3).map((n) => h('img', { src: iconUrl(n), alt: '' })))),
        h('div', { class: 'arc-pv-title subtitle' }, t('preview.selected', { count: nodes.length, n: i18n.formatNumber(nodes.length) })),
        this.meta([
          [t('preview.files'), i18n.formatNumber(files)],
          [t('preview.size'), size(total)],
        ]),
      );
      return;
    }
    const n = nodes[0] || this.w.folder;
    if (!n) return this.el.replaceChildren();
    const isRoot = n === this.w.tree?.root;
    if (n.dir) {
      const rows = [
        [t('preview.type'), isRoot ? t('props.archiveType', { fmt: (L.format || '').toUpperCase() }) : typeName(n, t)],
        [t('preview.contains'), t('props.containsVal', { files: i18n.formatNumber(n.files), dirs: i18n.formatNumber(n.dirs) })],
        [t('preview.size'), size(n.tsize)],
        L.perEntryPacked || isRoot ? [t('preview.packed'), size(isRoot ? L.size : n.tpacked)] : null,
        L.perEntryPacked || isRoot ? [t('preview.ratio'), pct(i18n, ratioOf(n.tsize, isRoot ? L.size : n.tpacked))] : null,
        [t('preview.modified'), date(isRoot ? L.mtime : n.mtime)],
        isRoot && L.encrypted ? [t('props.encrypted'), L.headersEncrypted ? t('props.encHeaders') : t('props.encData')] : null,
      ];
      this.el.replaceChildren(
        h('div', { class: 'arc-pv-hero' }, h('img', { class: 'arc-pv-icon', src: isRoot ? iconUrl({ name: L.name }) : iconUrl(n), alt: '' })),
        h('div', { class: 'arc-pv-title subtitle', 'data-tip': isRoot ? L.name : n.name }, isRoot ? L.name : n.name),
        this.meta(rows),
      );
      return;
    }
    const kind = previewKind(n);
    const rows = [
      [t('preview.type'), typeName(n, t)],
      [t('preview.size'), size(n.size)],
      L.perEntryPacked && n.packed != null ? [t('preview.packed'), size(n.packed)] : null,
      L.perEntryPacked && n.packed != null ? [t('preview.ratio'), pct(i18n, ratioOf(n.size, n.packed))] : null,
      [t('preview.modified'), date(n.mtime)],
      n.link ? [t('props.linkTarget'), n.link] : null,
      n.encrypted ? [t('props.encrypted'), t('common.yes')] : null,
    ];
    const stage = h('div', { class: ['arc-pv-stage', kind && 'loading'] });
    const openBtn = h('button', { class: 'btn', onclick: () => this.w.openNode(n) }, icon('open'), t('preview.open'));
    const extractBtn = h('button', { class: 'btn', onclick: () => this.w.extractSelected([n]) }, icon('folder_arrow_up'), t('preview.extract'));
    this.el.replaceChildren(stage, h('div', { class: 'arc-pv-title subtitle', 'data-tip': n.name }, n.name), this.meta(rows), h('div', { class: 'arc-pv-actions' }, openBtn, extractBtn));
    const showIcon = (msg) => {
      stage.classList.remove('loading');
      stage.replaceChildren(h('img', { class: 'arc-pv-icon', src: iconUrl(n), alt: '' }), msg ? h('div', { class: 'caption text-2 arc-pv-msg' }, msg) : null);
    };
    if (!kind) return showIcon();
    if ((kind === 'image' && n.size > IMAGE_MAX) || (kind === 'text' && n.size > TEXT_MAX)) return showIcon(t('preview.tooBig'));
    if (n.encrypted && this.w.password == null) {
      stage.classList.remove('loading');
      stage.replaceChildren(
        h('div', { class: 'arc-pv-lock' }, icon('lock_closed', { size: 32, filled: true })),
        h('div', { class: 'caption text-2 arc-pv-msg' }, t('preview.locked')),
        h('button', { class: 'btn small', onclick: async () => (await this.w.askPassword()) && this.update([n]) }, t('preview.unlock')),
      );
      return;
    }
    stage.appendChild(h('div', { class: 'spinner small' }));
    this.w
      .previewFile(n, { text: kind === 'text' ? TEXT_READ : 0 })
      .then((res) => {
        if (tok !== this.token) return;
        stage.classList.remove('loading');
        if (kind === 'image') {
          const img = h('img', { class: 'arc-pv-img', alt: n.name, draggable: false });
          img.onerror = () => tok === this.token && showIcon(t('preview.cannot'));
          img.onload = () => stage.classList.add('ready');
          img.src = this.w.api.mediaUrl(res.path);
          stage.replaceChildren(img);
        } else if (res.binary) showIcon(t('preview.binary'));
        else {
          const pre = h('pre', { class: ['arc-pv-text', 'selectable', extOf(n.name) === '.md' && 'md'], tabindex: '0', 'aria-label': n.name }, res.text || '');
          stage.replaceChildren(pre, res.truncated ? h('div', { class: 'caption text-2 arc-pv-trunc' }, t('preview.truncated')) : null);
        }
      })
      .catch((e) => {
        if (tok !== this.token) return;
        if (e?.code === 'ECANCELED') return;
        showIcon(e?.code === 'EPASSWORD' || e?.code === 'EBADPASSWORD' ? t('preview.locked') : t('preview.cannot'));
      });
  }

  clear() {
    this.token++;
    this.el.replaceChildren();
  }
}

function pct(i18n, r) {
  return r == null ? '' : `${i18n.formatNumber(Math.round(r * 100))} %`;
}
