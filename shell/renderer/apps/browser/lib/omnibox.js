// Aurora Browser — the address bar ("omnibox"): URL display with a strong host, site security
// chip, inline autocompletion, a suggestions dropdown (history, favorites, search), the star
// (favorite) button, zoom and blocked pop-up indicators.
import { h, icon, ui, clear } from './dom.js';
import { shared } from './shared.js';
import { classify, searchUrl, engineOf, urlParts, displayUrl, isInternal, isWebUrl, typedForm, hostOf } from './util.js';
import * as panels from './panels.js';

export class Omnibox {
  constructor(bw) {
    this.bw = bw;
    this.items = [];
    this.sel = -1;
    this.dirty = false;
    this.inline = null;
    this.userText = '';
    const t = bw.t;
    this.siteBtn = h('button', { class: 'bw-site', onclick: () => panels.siteInfo(bw, this.siteBtn) });
    this.input = h('input', {
      class: 'bw-omni-input',
      type: 'text',
      spellcheck: false,
      autocomplete: 'off',
      role: 'combobox',
      'aria-autocomplete': 'both',
      'aria-expanded': 'false',
    });
    this.display = h('div', { class: 'bw-omni-display', 'aria-hidden': 'true' });
    this.popupBtn = h('button', { class: 'bw-chip-btn bw-popup-btn', hidden: true, onclick: (e) => this.popupMenu(e) }, icon('window_ad_off', { size: 16 }));
    this.zoomBtn = h('button', { class: 'bw-chip-btn bw-zoom-btn', hidden: true, onclick: () => panels.zoomFlyout(bw, this.zoomBtn) });
    this.starBtn = h('button', { class: 'bw-chip-btn bw-star', onclick: () => panels.favoriteFlyout(bw) }, icon('star_add', { size: 16 }));
    this.el = h(
      'div',
      { class: 'bw-omni' },
      this.siteBtn,
      h('div', { class: 'bw-omni-field' }, this.input, this.display),
      h('div', { class: 'bw-omni-chips' }, this.popupBtn, this.zoomBtn, this.starBtn),
    );
    this.suggestEl = h('div', { class: 'bw-suggest', role: 'listbox', id: `bw-suggest-${Math.random().toString(36).slice(2, 8)}`, hidden: true });
    this.input.setAttribute('aria-controls', this.suggestEl.id);
    this.suggestEl.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
    this.relocalize();

    this.input.addEventListener('mousedown', (e) => {
      if (document.activeElement !== this.input && e.button === 0) {
        e.preventDefault();
        this.focus();
      }
    });
    this.input.addEventListener('focus', () => {
      this.el.classList.add('focused');
      this.updateSite();
    });
    this.input.addEventListener('blur', () => {
      this.el.classList.remove('focused');
      this.closeSuggest();
      if (!this.dirty) this.sync(bw.active);
      else this.updateSite();
    });
    this.input.addEventListener('input', (e) => this.onInput(e));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('paste', () => setTimeout(() => this.input.value && this.onInput({ inputType: 'insertFromPaste' }), 0));
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el || e.target.classList.contains('bw-omni-field') || e.target === this.display) {
        e.preventDefault();
        this.focus();
      }
    });
  }

  get editing() {
    return document.activeElement === this.input;
  }

  relocalize() {
    const t = this.bw.t;
    const engine = engineOf(this.bw.prefs.engine).name;
    this.input.placeholder = t('omni.placeholder', { engine });
    this.input.setAttribute('aria-label', t('omni.label'));
    this.popupBtn.dataset.tip = t('popup.blocked');
    this.popupBtn.setAttribute('aria-label', t('popup.blocked'));
    this.updateChips();
    this.updateSite();
  }

  focus() {
    if (this.bw.fs === 'user') this.bw.root.classList.add('bw-fs-reveal');
    this.input.focus();
    if (!this.dirty) this.input.value = this.fullText(this.bw.active);
    this.input.select();
  }

  fullText(tab) {
    const url = this.bw.tabUrl(tab);
    if (!url || url === 'aurora://newtab') return '';
    return displayUrl(url);
  }

  setEditedText(text) {
    this.dirty = true;
    this.input.value = text;
    this.display.hidden = true;
    this.el.classList.add('edited');
  }

  /** Show the active tab's URL (unless the user is typing). */
  /** Forget typed text (tab switch); the next sync() shows the tab's URL. */
  reset() {
    this.dirty = false;
    this.inline = null;
    this.el.classList.remove('edited');
    this.closeSuggest();
  }

  sync(tab) {
    if (!tab) return;
    const typing = this.editing && this.dirty;
    if (typing) {
      this.updateSite();
      this.updateChips();
      return;
    }
    this.dirty = false;
    this.inline = null;
    this.el.classList.remove('edited');
    const url = this.bw.tabUrl(tab);
    const text = this.fullText(tab);
    if (!this.editing) this.input.value = text;
    else if (this.input.value !== text) {
      // Focused but untouched: follow the navigation and keep it selected.
      this.input.value = text;
      this.input.select();
    }
    clear(this.display);
    if (text) {
      const p = urlParts(url);
      const scheme = /^https:/i.test(url) ? 'https' : /^http:/i.test(url) ? 'http' : '';
      this.display.append(h('span', { class: ['pre', scheme] }, p.pre), h('span', { class: 'host' }, p.host), h('span', { class: 'post' }, p.post));
    }
    this.display.hidden = !text;
    this.updateSite();
    this.updateChips();
  }

  security(tab) {
    if (!tab) return 'none';
    const url = this.bw.tabUrl(tab);
    if (isInternal(url)) return 'internal';
    if (tab.web?.error?.cert) return 'danger';
    if (/^https:/i.test(url)) return 'secure';
    if (/^http:/i.test(url)) {
      const host = hostOf(url);
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return 'local';
      return 'insecure';
    }
    return 'info';
  }

  updateSite() {
    const tab = this.bw.active;
    const t = this.bw.t;
    const b = this.siteBtn;
    let state = this.security(tab);
    const url = this.bw.tabUrl(tab);
    // Like Edge: the security chip stays until the user types; the search glyph shows while typing.
    if ((this.editing && this.dirty) || !url || url === 'aurora://newtab') state = 'search';
    if (b.dataset.state === `${state}:${this.bw.ctx.lang}`) return;
    b.dataset.state = `${state}:${this.bw.ctx.lang}`;
    b.className = `bw-site ${state}`;
    clear(b);
    let tip = '';
    if (state === 'search') {
      b.appendChild(icon('search', { size: 16 }));
      tip = t('omni.label');
    } else if (state === 'internal') {
      b.appendChild(h('img', { src: 'app://shell/apps/browser/icon.svg', alt: '', draggable: false }));
      tip = t('site.internal');
    } else if (state === 'secure') {
      b.appendChild(icon('lock_closed', { size: 16 }));
      tip = t('site.viewInfo');
    } else if (state === 'insecure' || state === 'danger') {
      b.appendChild(icon(state === 'danger' ? 'shield_error' : 'warning', { size: 16 }));
      b.appendChild(h('span', { class: 'bw-site-text' }, t('site.notSecure')));
      tip = t('site.viewInfo');
    } else {
      b.appendChild(icon('info', { size: 16 }));
      tip = t('site.viewInfo');
    }
    b.setAttribute('aria-label', tip);
    b.dataset.tip = tip;
    b.dataset.tipPos = 'below';
    b.disabled = state === 'search';
  }

  updateChips() {
    const bw = this.bw;
    const tab = bw.active;
    const t = bw.t;
    if (!tab) return;
    const url = bw.tabUrl(tab);
    // star
    const fav = shared.store.findBookmark(url);
    const canStar = !!url && url !== 'aurora://newtab' && !tab.lazy;
    this.starBtn.hidden = !canStar;
    this.starBtn.classList.toggle('on', !!fav);
    const ic = fav ? 'star' : 'star_add';
    if (this.starBtn.dataset.icon !== ic) {
      this.starBtn.dataset.icon = ic;
      clear(this.starBtn).appendChild(icon(ic, { size: 16, filled: !!fav }));
    }
    const starTip = fav ? t('fav.edit') : t('fav.add');
    this.starBtn.dataset.tip = `${starTip} (Ctrl+D)`;
    this.starBtn.dataset.tipPos = 'below';
    this.starBtn.setAttribute('aria-label', starTip);
    // zoom
    const z = tab.zoom || 1;
    const showZoom = Math.abs(z - 1) > 0.001;
    this.zoomBtn.hidden = !showZoom;
    if (showZoom) {
      const zi = z > 1 ? 'zoom_in' : 'zoom_out';
      if (this.zoomBtn.dataset.icon !== zi) {
        this.zoomBtn.dataset.icon = zi;
        clear(this.zoomBtn).appendChild(icon(zi, { size: 16 }));
      }
      const zt = t('zoom.level', { pct: Math.round(z * 100) });
      this.zoomBtn.dataset.tip = zt;
      this.zoomBtn.dataset.tipPos = 'below';
      this.zoomBtn.setAttribute('aria-label', zt);
    }
    // blocked pop-ups
    this.popupBtn.hidden = !tab.blockedPopups?.length;
  }

  popupMenu(e) {
    const tab = this.bw.active;
    if (!tab?.blockedPopups.length) return;
    ui.menu(
      e,
      [
        { header: this.bw.t('popup.blocked') },
        ...tab.blockedPopups.slice(-8).map((u) => ({
          label: displayUrl(u).slice(0, 80),
          icon: 'open',
          action: () => {
            tab.blockedPopups = tab.blockedPopups.filter((x) => x !== u);
            this.bw.openUrl(u, { opener: tab });
            this.updateChips();
          },
        })),
      ],
      { class: this.bw.menuClass() },
    );
  }

  // ---------------------------------------------------------------- typing & suggestions
  onInput(e) {
    this.dirty = true;
    this.el.classList.add('edited');
    this.display.hidden = true;
    const value = this.input.value;
    const deleting = String(e?.inputType || '').startsWith('delete');
    let typed = value;
    this.inline = null;
    if (!deleting && this.input.selectionStart === value.length && value.length >= 2 && !/\s/.test(value)) {
      const c = shared.store.inlineCompletion(value);
      if (c && c.text.toLowerCase().startsWith(value.toLowerCase())) {
        this.inline = c;
        this.input.value = value + c.text.slice(value.length);
        this.input.setSelectionRange(value.length, this.input.value.length);
      }
    }
    this.userText = typed;
    if (this.bw.active) this.bw.active.omniText = typed;
    this.updateSite();
    this.buildSuggestions(typed);
  }

  buildSuggestions(typed) {
    const bw = this.bw;
    const t = bw.t;
    const engineId = bw.prefs.engine;
    const engine = engineOf(engineId).name;
    const q = typed.trim();
    if (!q) {
      this.closeSuggest();
      return;
    }
    const items = [];
    const c = classify(q, engineId);
    if (this.inline) {
      const hist = shared.store.history.get(this.inline.url);
      items.push({ kind: 'url', url: this.inline.url, title: hist?.title || '', text: this.inline.text });
    } else if (c?.type === 'search') items.push({ kind: 'search', query: q, url: c.url, sub: t('omni.searchWith', { engine }) });
    else if (c) items.push({ kind: c.type === 'internal' ? 'internal' : 'url', url: c.url, title: '', text: displayUrl(c.url), go: true });
    const primaryUrl = items[0]?.url;
    for (const m of shared.store.suggest(q, 6)) {
      if (m.url === primaryUrl) {
        if (!items[0].title) items[0].title = m.title;
        items[0].kind2 = m.kind;
        continue;
      }
      items.push({ kind: m.kind, url: m.url, title: m.title, text: displayUrl(m.url) });
    }
    if (items[0]?.kind !== 'search') items.push({ kind: 'search', query: q, url: searchUrl(engineId, q), sub: t('omni.searchWith', { engine }) });
    this.items = items.slice(0, 8);
    this.sel = 0;
    this.renderSuggest();
  }

  renderSuggest() {
    const bw = this.bw;
    const t = bw.t;
    const box = this.suggestEl;
    if (!box.isConnected) bw.root.appendChild(box);
    clear(box);
    this.items.forEach((it, i) => {
      let ic;
      if (it.kind === 'search') ic = icon('search', { size: 16 });
      else if (it.kind === 'internal') ic = h('img', { src: 'app://shell/apps/browser/icon.svg', alt: '' });
      else {
        const fav = !bw.private ? shared.store.favicon(it.url) : null;
        ic = fav ? h('img', { src: fav, alt: '' }) : icon(it.kind === 'bookmark' ? 'star' : it.kind === 'history' ? 'history' : 'globe', { size: 16 });
      }
      const main = it.kind === 'search' ? it.query : it.title || it.text || it.url;
      const sub = it.kind === 'search' ? it.sub : it.title ? displayUrl(it.url) : '';
      const row = h(
        'div',
        { class: ['bw-sug', i === this.sel && 'sel'], role: 'option', id: `${box.id}-${i}`, 'aria-selected': i === this.sel ? 'true' : 'false' },
        h('span', { class: 'bw-sug-icon' }, ic),
        h('span', { class: 'bw-sug-text' }, h('span', { class: 'bw-sug-main' }, main), sub ? h('span', { class: 'bw-sug-sub' }, ` — ${sub}`) : null),
        it.kind === 'bookmark' || it.kind2 === 'bookmark' ? h('span', { class: 'bw-sug-tag' }, icon('star', { size: 12, filled: true })) : null,
        it.kind === 'history'
          ? h(
              'button',
              {
                class: 'bw-sug-del',
                tabindex: '-1',
                'aria-label': t('omni.removeSuggestion'),
                'data-tip': `${t('omni.removeSuggestion')} (Shift+Del)`,
                onclick: (e) => {
                  e.stopPropagation();
                  this.removeItem(i);
                },
              },
              icon('dismiss', { size: 12 }),
            )
          : null,
      );
      row.addEventListener('click', (e) => this.accept(i, e));
      row.addEventListener('auxclick', (e) => e.button === 1 && this.accept(i, { altKey: true }));
      row.addEventListener('mousemove', () => {
        if (this.sel !== i) this.select(i, false);
      });
      box.appendChild(row);
    });
    box.hidden = !this.items.length;
    this.input.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
    this.input.setAttribute('aria-activedescendant', this.sel >= 0 ? `${box.id}-${this.sel}` : '');
    this.el.classList.toggle('open', !box.hidden);
    this.layout();
  }

  layout() {
    const box = this.suggestEl;
    if (box.hidden || !box.isConnected) return;
    const rr = this.bw.root.getBoundingClientRect();
    const r = this.el.getBoundingClientRect();
    box.style.left = `${Math.round(r.left - rr.left)}px`;
    box.style.width = `${Math.round(r.width)}px`;
    box.style.top = `${Math.round(r.bottom - rr.top + 4)}px`;
  }

  select(i, fill = true) {
    this.sel = i;
    [...this.suggestEl.children].forEach((row, j) => {
      row.classList.toggle('sel', j === i);
      row.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
    this.input.setAttribute('aria-activedescendant', i >= 0 ? `${this.suggestEl.id}-${i}` : '');
    if (!fill) return;
    const it = this.items[i];
    if (!it) {
      this.input.value = this.userText;
      return;
    }
    if (i === 0 && this.inline) {
      this.input.value = this.userText + this.inline.text.slice(this.userText.length);
      this.input.setSelectionRange(this.userText.length, this.input.value.length);
    } else this.input.value = it.kind === 'search' ? it.query : it.text || displayUrl(it.url);
  }

  removeItem(i) {
    const it = this.items[i];
    if (!it || it.kind !== 'history') return;
    shared.store.removeHistory(it.url);
    this.items.splice(i, 1);
    if (this.sel >= this.items.length) this.sel = this.items.length - 1;
    this.renderSuggest();
  }

  closeSuggest() {
    if (this.suggestEl.hidden) return;
    this.suggestEl.hidden = true;
    this.el.classList.remove('open');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  accept(i, e = {}) {
    const bw = this.bw;
    const it = this.items[i];
    let target;
    if (!it) target = classify(this.input.value, bw.prefs.engine);
    else if (it.kind === 'search') target = { type: 'search', url: it.url, query: it.query };
    else target = classify(it.url, bw.prefs.engine) || { type: 'url', url: it.url };
    this.go(target, e);
  }

  go(target, e = {}) {
    const bw = this.bw;
    if (!target) return;
    this.closeSuggest();
    this.dirty = false;
    this.inline = null;
    this.el.classList.remove('edited');
    if (bw.active) bw.active.omniText = null;
    if (e.altKey || e.button === 1) {
      bw.openUrl(target.url, { active: true });
      this.sync(bw.active);
      return;
    }
    bw.navigate(bw.active, target);
    this.input.blur();
    this.sync(bw.active);
    bw.focusPage();
  }

  onKey(e) {
    const open = !this.suggestEl.hidden && this.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        if (this.input.value.trim()) this.buildSuggestions(this.userText || this.input.value);
        return;
      }
      const n = this.items.length;
      const next = e.key === 'ArrowDown' ? (this.sel + 1) % n : (this.sel - 1 + n) % n;
      this.select(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey && !/[.\s/:]/.test(this.userText || this.input.value)) {
        // Ctrl+Enter: "example" -> https://www.example.com/
        const word = (this.userText || this.input.value).trim();
        if (word) return this.go({ type: 'url', url: `https://www.${word}.com/` }, e);
      }
      if (open && this.sel >= 0) this.accept(this.sel, e);
      else this.go(classify(this.input.value, this.bw.prefs.engine), e);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (open) {
        if (this.sel > 0) {
          this.select(0);
          return;
        }
        this.closeSuggest();
      }
      if (this.dirty) {
        this.dirty = false;
        if (this.bw.active) this.bw.active.omniText = null;
        this.el.classList.remove('edited');
        this.input.value = this.fullText(this.bw.active);
        this.input.select();
        this.updateSite();
      } else {
        this.input.blur();
        this.bw.focusPage();
      }
    } else if (e.key === 'Delete' && e.shiftKey && open && this.items[this.sel]?.kind === 'history') {
      e.preventDefault();
      this.removeItem(this.sel);
    } else if (e.key === 'Tab' && open && this.inline && !e.shiftKey && this.input.selectionEnd > this.input.selectionStart) {
      // Accept the inline completion without navigating.
      e.preventDefault();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      this.userText = this.input.value;
      this.inline = null;
      this.buildSuggestions(this.userText);
    }
  }
}

export { typedForm, isWebUrl };
