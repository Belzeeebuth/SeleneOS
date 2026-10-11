// Preview pane (Explorer's preview + details panes in one): pictures and text files are extracted on demand
// to the window's private temp folder and shown inline; other items show their icon and properties.
import { iconUrl, typeName, previewKind, ratioOf, extOf, containsText } from './util.js';

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
    this.abort();
    const tok = ++this.token;
    this.timer = setTimeout(() => this.render(nodes, tok), nodes.length === 1 && previewKind(nodes[0]) ? 140 : 0);
  }

  /** Stop the extraction of a preview that is no longer shown (arrowing through a big solid archive must not
   *  pile up extractions). */
  abort() {
    if (this.opId) this.w.api.invoke('archive:cancel', this.opId).catch(() => {});
    this.opId = null;
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
        [t('preview.contains'), containsText(n.files, n.dirs, t, i18n)],
        [t('preview.size'), size(n.tsize)],
        L.perEntryPacked || isRoot ? [t('preview.packed'), size(isRoot ? L.size : n.tpacked)] : null,
        L.perEntryPacked || isRoot ? [t('preview.ratio'), pct(this.w, ratioOf(n.tsize, isRoot ? L.size : n.tpacked))] : null,
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
    const rows = () => [
      [t('preview.type'), typeName(n, t)],
      [t('preview.size'), size(n.size)],
      L.perEntryPacked && n.packed != null ? [t('preview.packed'), size(n.packed)] : null,
      L.perEntryPacked && n.packed != null ? [t('preview.ratio'), pct(this.w, ratioOf(n.size, n.packed))] : null,
      [t('preview.modified'), date(n.mtime)],
      n.link ? [t('props.linkTarget'), n.link] : null,
      n.encrypted ? [t('props.encrypted'), t('common.yes')] : null,
    ];
    const stage = h('div', { class: ['arc-pv-stage', (kind || n.link != null) && 'loading'] });
    const openBtn = h('button', { class: 'btn', onclick: () => this.w.openNode(n) }, icon('open'), t('preview.open'));
    const extractBtn = h('button', { class: 'btn', onclick: () => this.w.extractSelected([n]) }, icon('folder_arrow_up'), t('preview.extract'));
    let metaEl = this.meta(rows());
    this.el.replaceChildren(stage, h('div', { class: 'arc-pv-title subtitle', 'data-tip': n.name }, n.name), metaEl, h('div', { class: 'arc-pv-actions' }, openBtn, extractBtn));
    const showIcon = (msg) => {
      stage.classList.remove('loading');
      stage.replaceChildren(...[h('img', { class: 'arc-pv-icon', src: iconUrl(n), alt: '' }), msg ? h('div', { class: 'caption text-2 arc-pv-msg' }, msg) : null].filter(Boolean));
    };
    if (!kind && n.link == null) return showIcon();
    if ((kind === 'image' && n.size > IMAGE_MAX) || (kind === 'text' && n.size > TEXT_MAX)) return showIcon(t('preview.tooBig'));
    const locked = (wrong) => {
      stage.classList.remove('loading');
      stage.replaceChildren(
        h('div', { class: 'arc-pv-lock' }, icon('lock_closed', { size: 32, filled: true })),
        h('div', { class: ['caption', 'arc-pv-msg', wrong ? 'arc-err' : 'text-2'], role: wrong ? 'alert' : null }, wrong ? t('pw.wrong') : t('preview.locked')),
        h('button', { class: 'btn small', onclick: async () => (await this.w.askPassword(wrong)) != null && this.update([n]) }, t('preview.unlock')),
      );
    };
    if (n.encrypted && this.w.password == null) return locked(false);
    stage.appendChild(h('div', { class: 'spinner small' }));
    // a link shows its target (inside the archive) instead: links are never extracted for a preview
    const load = (node, k) =>
      node.link
        ? Promise.resolve({ link: node.link })
        : this.w.previewFile(node, { text: k === 'text' ? TEXT_READ : 0, onOp: (id) => tok === this.token && (this.opId = id) });
    const show = (node, k, res) => {
      if (tok !== this.token) return;
      if (res.link != null) {
        if (node.link === '') {
          node.link = res.link; // zip / 7z: the target is only known now
          if (node === n) {
            const fresh = this.meta(rows());
            metaEl.replaceWith(fresh);
            metaEl = fresh;
          }
        }
        const tgt = this.w.resolveLink(node, res.link);
        if (tgt && !tgt.dir && previewKind(tgt) && tgt !== node && !(tgt.encrypted && this.w.password == null)) {
          return load(tgt, previewKind(tgt)).then((r) => show(tgt, previewKind(tgt), r));
        }
        return showIcon(t('preview.linkTo', { target: res.link }));
      }
      this.opId = null;
      stage.classList.remove('loading');
      if (k === 'image') {
        const img = h('img', { class: 'arc-pv-img', alt: node.name, draggable: false });
        img.onerror = () => tok === this.token && showIcon(t('preview.cannot'));
        img.onload = () => stage.classList.add('ready');
        img.src = this.w.api.mediaUrl(res.path);
        stage.replaceChildren(img);
      } else if (res.binary) showIcon(t('preview.binary'));
      else {
        const pre = h('pre', { class: ['arc-pv-text', 'selectable', extOf(node.name) === '.md' && 'md'], tabindex: '0', 'aria-label': node.name }, res.text || '');
        stage.replaceChildren(...[pre, res.truncated ? h('div', { class: 'caption text-2 arc-pv-trunc' }, t('preview.truncated')) : null].filter(Boolean));
      }
    };
    load(n, kind)
      .then((res) => show(n, kind, res))
      .catch((e) => {
        if (tok !== this.token) return;
        this.opId = null;
        if (e?.code === 'ECANCELED') return;
        if (e?.code === 'EBADPASSWORD') this.w.password = null; // ask again (with "wrong password")
        if (e?.code === 'EPASSWORD' || e?.code === 'EBADPASSWORD') return locked(e.code === 'EBADPASSWORD');
        showIcon(t('preview.cannot'));
      });
  }

  clear() {
    this.abort();
    this.token++;
    this.el.replaceChildren();
  }
}

function pct(w, r) {
  return r == null ? '' : w.t('fmt.pct', { n: w.i18n.formatNumber(Math.round(r * 100)) });
}
