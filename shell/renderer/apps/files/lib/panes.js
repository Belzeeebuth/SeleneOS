// Right-hand pane of File Explorer: the Details pane (Alt+Shift+P) or the Preview pane (Alt+P).
import { shared } from './shared.js';
import * as T from './types.js';

export class SidePane {
  constructor(ex) {
    this.ex = ex;
    const { h } = ex;
    this.body = h('div', { class: 'fx-pane-body' });
    this.el = h('aside', { class: 'fx-pane', 'aria-live': 'polite', hidden: true }, this.body);
    this.kind = null;
    this.seq = 0;
  }

  setKind(kind) {
    this.kind = kind;
    this.el.hidden = !kind;
    this.el.setAttribute('aria-label', kind ? this.ex.t(kind === 'preview' ? 'pane.preview' : 'pane.details') : '');
    this.lastKey = null;
    this.update(true);
  }

  update(force = false) {
    if (!this.kind) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(force), 60);
  }

  render(force) {
    const items = this.ex.view.selectedItems();
    const key = `${this.kind}|${this.ex.tab ? this.ex.locKey(this.ex.tab.loc) : ''}|${items.map((i) => i.key).join('\n')}|${shared.prefs.extensions}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const seq = ++this.seq;
    // Stop any playing media before replacing the content.
    this.body.querySelectorAll('video, audio').forEach((m) => m.pause());
    if (this.kind === 'preview') this.preview(items, seq);
    else this.details(items, seq);
  }

  // ---------------------------------------------------------------- preview pane
  async preview(items, seq) {
    const { h, t, api } = this.ex;
    const msg = (text) => this.body.replaceChildren(h('div', { class: 'fx-pane-msg' }, text));
    if (items.length !== 1) return msg(t(items.length ? 'pane.multiPreview' : 'pane.selectToPreview'));
    const it = items[0];
    const e = it.entry;
    if (it.kind === 'drive' || e.dir || e.missing) return msg(t('pane.noPreview'));
    const src = it.kind === 'trash' ? e.path : e.path;
    if (!T.isRegular(e)) return msg(t('pane.noPreview'));
    if (T.isImage(e)) {
      const img = h('img', { class: 'fx-pv-img', src: api.mediaUrl(src), alt: e.name });
      img.addEventListener('error', () => seq === this.seq && msg(t('pane.noPreview')), { once: true });
      return this.body.replaceChildren(h('div', { class: 'fx-pv-media' }, img));
    }
    if (T.isVideo(e)) {
      return this.body.replaceChildren(h('div', { class: 'fx-pv-media' }, h('video', { class: 'fx-pv-video', src: api.mediaUrl(src), controls: true, preload: 'metadata' })));
    }
    if (T.isAudio(e)) {
      return this.body.replaceChildren(h('div', { class: 'fx-pv-audio' },
        h('img', { src: T.iconFor(e), alt: '' }),
        h('div', { class: 'body-strong ellipsis' }, e.name),
        h('audio', { src: api.mediaUrl(src), controls: true, preload: 'metadata' })));
    }
    if (T.isTextLike(e) || (!e.ext && e.size < 256 * 1024) || ['.json', '.csv', '.tsv', '.svg'].includes(e.ext)) {
      msg(t('common.loading'));
      try {
        const res = await api.invoke('files:head', src, 65536);
        if (seq !== this.seq) return;
        if (res.binary) return msg(t('pane.noPreview'));
        const pre = h('pre', { class: 'fx-pv-text selectable' }, res.text);
        return this.body.replaceChildren(h('div', { class: 'fx-pv-textwrap' }, pre, res.truncated ? h('div', { class: 'caption text-2 fx-pv-trunc' }, t('pane.truncated')) : null));
      } catch {
        if (seq === this.seq) msg(t('pane.noPreview'));
      }
      return;
    }
    msg(t('pane.noPreview'));
  }

  // ---------------------------------------------------------------- details pane
  prop(label, value) {
    const { h } = this.ex;
    if (value == null || value === '') return null;
    return h('div', { class: 'fx-dp-row' }, h('div', { class: 'k caption text-2' }, label), h('div', { class: 'v selectable' }, value));
  }

  async details(items, seq) {
    const { h, t, api } = this.ex;
    const loc = this.ex.tab?.loc;
    const wrap = h('div', { class: 'fx-dp' });
    const header = (visual, name, sub) => h('div', { class: 'fx-dp-head' }, h('div', { class: 'fx-dp-visual' }, visual), h('div', { class: 'fx-dp-name selectable' }, name), sub ? h('div', { class: 'caption text-2' }, sub) : null);
    const iconImg = (src, cls = '') => h('img', { class: `fx-dp-icon ${cls}`, src, alt: '' });
    if (!items.length) {
      // Nothing selected: describe the current location.
      const n = this.ex.view.items.length;
      let visual = iconImg(this.ex.locIcon(loc));
      wrap.append(header(visual, this.ex.locName(loc), loc.type === 'home' || loc.type === 'thispc' ? null : t('status.items', { count: n })));
      if (loc.type === 'dir') {
        const st = await api.invoke('files:props', loc.path).catch(() => null);
        if (seq !== this.seq) return;
        if (st) {
          wrap.append(h('div', { class: 'fx-dp-sec caption text-2' }, t('pane.properties')),
            this.prop(t('props.location'), T.dirname(st.path)),
            this.prop(t('props.modified'), T.formatDate(st.mtime)),
            this.prop(t('props.created'), T.formatDate(st.birthtime)),
            this.prop(t('perm.ownerName'), st.owner));
        }
      } else if (loc.type === 'thispc' || loc.type === 'home') {
        wrap.append(h('div', { class: 'fx-pane-msg small' }, t('pane.selectForDetails')));
      }
      return this.body.replaceChildren(wrap);
    }
    if (items.length > 1) {
      const files = items.filter((i) => i.entry && !i.entry.dir);
      const total = files.reduce((s, i) => s + (i.entry.size || 0), 0);
      const stack = h('div', { class: 'fx-dp-stack' }, ...items.slice(0, 3).reverse().map((i, k) => h('img', { src: i.kind === 'drive' ? T.driveIcon(i.entry.drive) : T.iconFor(i.entry), alt: '', style: { '--k': String(k) } })));
      wrap.append(header(stack, t('status.selected', { count: items.length }), files.length ? T.humanSize(total) : null));
      const types = new Set(items.map((i) => i.type));
      wrap.append(h('div', { class: 'fx-dp-sec caption text-2' }, t('pane.properties')),
        this.prop(t('props.type'), types.size === 1 ? [...types][0] : t('props.multipleTypes')),
        files.length ? this.prop(t('props.size'), T.humanSize(total)) : '',
        this.prop(t('cols.mtime'), (() => {
          const ms = items.map((i) => i.entry?.mtime).filter(Boolean);
          if (!ms.length) return '';
          const a = Math.min(...ms);
          const b = Math.max(...ms);
          return a === b ? T.formatDate(a) : `${T.formatDate(a)} – ${T.formatDate(b)}`;
        })()));
      return this.body.replaceChildren(wrap);
    }
    const it = items[0];
    const e = it.entry;
    if (it.kind === 'drive') {
      const d = e.drive;
      const used = d.size && d.free != null ? d.size - d.free : null;
      const frac = used != null && d.size ? used / d.size : 0;
      wrap.append(header(iconImg(T.driveIcon(d)), e.name, d.fstype || null));
      if (used != null) wrap.append(h('div', { class: ['fx-cap', 'fx-dp-cap', frac > 0.9 && 'full'] }, h('div', { class: 'fill', style: { width: `${Math.round(frac * 100)}%` } })));
      wrap.append(h('div', { class: 'fx-dp-sec caption text-2' }, t('pane.properties')),
        this.prop(t('drives.used'), used != null ? T.humanSize(used) : ''),
        this.prop(t('drives.freeSpace'), d.free != null ? T.humanSize(d.free) : ''),
        this.prop(t('drives.capacity'), T.humanSize(d.size)),
        this.prop(t('drives.fileSystem'), d.fstype),
        this.prop(t('drives.device'), d.device),
        this.prop(t('drives.mountpoint'), d.mountpoint || t('drives.notMounted')));
      return this.body.replaceChildren(wrap);
    }
    let visual;
    if (T.isImage(e) && T.isRegular(e) && !e.missing) {
      visual = h('img', { class: 'fx-dp-thumb', src: api.mediaUrl(e.path), alt: '' });
      visual.addEventListener('error', () => visual.replaceWith(iconImg(T.iconFor(e))), { once: true });
    } else visual = iconImg(T.iconFor(e));
    wrap.append(header(visual, e.name, it.type));
    const sec = h('div', { class: 'fx-dp-props' });
    wrap.append(h('div', { class: 'fx-dp-sec caption text-2' }, t('pane.properties')), sec);
    if (it.kind === 'trash') {
      sec.append(...[
        this.prop(t('props.origin'), T.dirname(e.originalPath || '')),
        this.prop(t('cols.deleted'), T.formatDate(e.deletedAt)),
        e.dir ? null : this.prop(t('props.size'), T.humanSize(e.size)),
        this.prop(t('props.modified'), T.formatDate(e.mtime)),
      ].filter(Boolean));
      return this.body.replaceChildren(wrap);
    }
    sec.append(...[
      e.dir ? null : this.prop(t('props.size'), T.humanSize(e.size)),
      this.prop(t('props.location'), T.dirname(e.path)),
      this.prop(t('props.modified'), T.formatDate(e.mtime)),
    ].filter(Boolean));
    this.body.replaceChildren(wrap);
    if (e.missing) return;
    const info = await api.invoke('files:props', e.path).catch(() => null);
    if (seq !== this.seq || !info) return;
    const extra = [this.prop(t('props.created'), T.formatDate(info.birthtime)), this.prop(t('props.accessed'), T.formatDate(info.atime)), this.prop(t('perm.ownerName'), info.owner)];
    if (info.link) extra.push(this.prop(t('props.target'), info.target));
    sec.append(...extra.filter(Boolean));
    if (e.dir) {
      api.invoke('fs:list', e.path, { hidden: shared.prefs.hidden }).then((list) => {
        if (seq === this.seq) sec.append(this.prop(t('props.contains'), t('status.items', { count: list.length })) || '');
      }).catch(() => {});
    }
    if (T.isImage(e) && visual.tagName === 'IMG') {
      const done = () => {
        if (seq === this.seq && visual.naturalWidth) sec.append(this.prop(t('props.dimensions'), `${visual.naturalWidth} × ${visual.naturalHeight}`));
      };
      if (visual.complete) done();
      else visual.addEventListener('load', done, { once: true });
    }
  }
}
