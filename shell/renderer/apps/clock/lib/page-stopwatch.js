// Clock — Stopwatch page: big hh:mm:ss.cc digits computed from timestamps (keeps running in the
// background and across restarts), start / pause / lap / reset (Space, L, R), laps & splits table with
// the fastest and slowest laps highlighted, copy laps to the clipboard, compact "focus" view.
import { swParts } from './time.js';
import { enter } from './widgets.js';

export class StopwatchPage {
  constructor(app) {
    this.app = app;
    this.lapCount = -1;
  }

  get store() {
    return this.app.store;
  }

  build() {
    const { h, t, icon } = this.app;
    const group = (cls, unit) => {
      const el = h('span', { class: `ck-sw-num ${cls}` }, '00');
      return [el, h('div', { class: 'ck-sw-group' }, el, h('span', { class: 'ck-sw-unit caption text-2' }, unit))];
    };
    const [hEl, hG] = group('h', t('stopwatch.hr'));
    const [mEl, mG] = group('m', t('stopwatch.min'));
    const [sEl, sG] = group('s', t('stopwatch.sec'));
    const [cEl, cG] = group('cs', '');
    this.num = { h: hEl, m: mEl, s: sEl, cs: cEl };
    const sep = (c) => h('span', { class: 'ck-sw-sep', 'aria-hidden': 'true' }, c);
    this.display = h('div', { class: 'ck-sw-display', role: 'timer', 'aria-live': 'off', 'aria-label': t('stopwatch.label') }, hG, sep(':'), mG, sep(':'), sG, sep(this.app.lang === 'fr' ? ',' : '.'), cG);
    this.playBtn = h('button', { type: 'button', class: 'btn primary ck-round big ck-sw-play', onclick: () => this.store.swToggle() });
    this.lapBtn = h('button', { type: 'button', class: 'btn ck-round big ck-sw-lap', 'aria-label': t('stopwatch.lap'), 'data-tip': `${t('stopwatch.lap')} (L)`, onclick: () => this.store.swLap() }, icon('flag'));
    this.resetBtn = h('button', { type: 'button', class: 'btn ck-round big ck-sw-reset', 'aria-label': t('stopwatch.reset'), 'data-tip': `${t('stopwatch.reset')} (R)`, onclick: () => this.store.swReset() }, icon('arrow_reset'));
    this.expandBtn = h(
      'button',
      { type: 'button', class: 'btn subtle icon-btn ck-sw-expand', onclick: () => this.setExpanded(!this.el.classList.contains('expanded')) },
      icon('full_screen_maximize'),
    );
    this.copyBtn = h('button', { type: 'button', class: 'btn subtle ck-sw-copy', onclick: () => this.copyLaps() }, icon('copy'), h('span', { class: 'ck-sw-copy-label' }, t('stopwatch.copy')));
    this.tbody = h('div', { class: 'ck-laps-body', role: 'rowgroup' });
    this.laps = h(
      'div',
      { class: 'ck-laps', role: 'table', 'aria-label': t('stopwatch.laps') },
      h(
        'div',
        { class: 'ck-laps-head', role: 'row' },
        h('span', { role: 'columnheader' }, t('stopwatch.lapCol')),
        h('span', { role: 'columnheader' }, t('stopwatch.timeCol')),
        h('span', { role: 'columnheader' }, t('stopwatch.totalCol')),
        h('span', { class: 'ck-laps-tools' }, this.copyBtn),
      ),
      this.tbody,
    );
    this.el = h(
      'section',
      { class: 'ck-sw' },
      h('div', { class: 'ck-sw-top' }, this.expandBtn),
      h('div', { class: 'ck-sw-center' }, this.display, h('div', { class: 'ck-sw-actions' }, this.playBtn, this.lapBtn, this.resetBtn), h('div', { class: 'ck-sw-hint caption text-2' }, t('stopwatch.hint'))),
      this.laps,
    );
    this.setExpanded(false);
    this.render();
    return this.el;
  }

  setExpanded(on) {
    const { t, icon } = this.app;
    this.el.classList.toggle('expanded', on);
    const label = on ? t('stopwatch.collapse') : t('stopwatch.expand');
    this.expandBtn.replaceChildren(icon(on ? 'full_screen_minimize' : 'full_screen_maximize'));
    this.expandBtn.setAttribute('aria-label', label);
    this.expandBtn.dataset.tip = label;
  }

  render() {
    const { t, icon } = this.app;
    const s = this.store.stopwatch;
    const ic = s.running ? 'pause' : 'play';
    if (this.playBtn.dataset.icon !== ic) {
      this.playBtn.replaceChildren(icon(ic, { filled: true }));
      this.playBtn.dataset.icon = ic;
    }
    const label = s.running ? t('stopwatch.pause') : this.store.swElapsed() > 0 ? t('stopwatch.resume') : t('stopwatch.start');
    this.playBtn.setAttribute('aria-label', label);
    this.playBtn.dataset.tip = `${label} (${t('stopwatch.spaceKey')})`;
    this.lapBtn.disabled = !s.running;
    this.resetBtn.disabled = s.running ? false : this.store.swElapsed() === 0 && !s.laps.length;
    this.el.classList.toggle('running', s.running);
    this.renderLaps();
    this.tick(Date.now());
  }

  renderLaps() {
    const { h, t, lang } = this.app;
    const laps = this.store.stopwatch.laps;
    this.laps.hidden = laps.length === 0;
    this.copyBtn.disabled = laps.length === 0;
    if (laps.length === this.lapCount && this.tbody.children.length === laps.length) return;
    const added = laps.length === this.lapCount + 1;
    this.lapCount = laps.length;
    const splits = laps.map((v, i) => v - (i ? laps[i - 1] : 0));
    let fast = -1;
    let slow = -1;
    if (splits.length >= 2) {
      fast = splits.indexOf(Math.min(...splits));
      slow = splits.indexOf(Math.max(...splits));
      if (fast === slow) fast = slow = -1;
    }
    this.tbody.replaceChildren();
    for (let i = laps.length - 1; i >= 0; i--) {
      const tag = i === fast ? h('span', { class: 'ck-lap-tag fast' }, t('stopwatch.fastest')) : i === slow ? h('span', { class: 'ck-lap-tag slow' }, t('stopwatch.slowest')) : null;
      const row = h(
        'div',
        { class: ['ck-lap', i === fast && 'fast', i === slow && 'slow'], role: 'row', dataset: { lap: String(i + 1) } },
        h('span', { role: 'cell', class: 'ck-lap-n' }, String(i + 1).padStart(2, '0'), tag),
        h('span', { role: 'cell', class: 'ck-lap-split' }, this.fmt(splits[i], lang)),
        h('span', { role: 'cell', class: 'ck-lap-total' }, this.fmt(laps[i], lang)),
      );
      this.tbody.appendChild(row);
    }
    if (added && this.tbody.firstChild) enter(this.tbody.firstChild, { y: -8, duration: 200 });
  }

  fmt(ms, lang) {
    const { h, m, s, cs } = swParts(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(s)}${lang === 'fr' ? ',' : '.'}${p(cs)}`;
  }

  tick(now) {
    const { h, m, s, cs } = swParts(this.store.swElapsed(now));
    const p = (n) => String(n).padStart(2, '0');
    const set = (el, v) => el.textContent !== v && (el.textContent = v);
    set(this.num.h, p(h));
    set(this.num.m, p(m));
    set(this.num.s, p(s));
    set(this.num.cs, p(cs));
  }

  wantsFrames() {
    return this.store.stopwatch.running;
  }

  onStore(kind) {
    if (kind === 'stopwatch' || kind === 'all') this.render();
  }

  onKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString() && this.store.stopwatch.laps.length) {
        this.copyLaps();
        return true;
      }
      return false;
    }
    // Space on a focused button already clicks it; ignore auto-repeat (holding a key down)
    if (e.key === ' ' && e.target?.closest?.('button')) return false;
    if (e.repeat) return /^( |l|r)$/i.test(e.key);
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') this.store.swToggle();
    else if (k === 'l') this.store.swLap();
    else if (k === 'r') this.store.swReset();
    else if (k === 'escape' && this.el.classList.contains('expanded')) this.setExpanded(false);
    else return false;
    return true;
  }

  async copyLaps() {
    const { t, lang, api, ui, win } = { ...this.app, api: this.app.ctx.api };
    const laps = this.store.stopwatch.laps;
    if (!laps.length) return;
    const lines = [`${t('stopwatch.lapCol')}\t${t('stopwatch.timeCol')}\t${t('stopwatch.totalCol')}`];
    laps.forEach((v, i) => lines.push(`${i + 1}\t${this.fmt(v - (i ? laps[i - 1] : 0), lang)}\t${this.fmt(v, lang)}`));
    try {
      await api.invoke('clipboard:writeText', lines.join('\n'));
      this.copyBtn.classList.add('copied');
      this.copyBtn.querySelector('.ck-sw-copy-label').textContent = t('stopwatch.copied');
      clearTimeout(this._copyT);
      this._copyT = setTimeout(() => {
        this.copyBtn.classList.remove('copied');
        this.copyBtn.querySelector('.ck-sw-copy-label').textContent = t('stopwatch.copy');
      }, 1600);
    } catch (err) {
      ui.alert(t('errors.copy', { msg: err.message }), { title: t('errors.title'), parent: win });
    }
  }

  destroy() {
    clearTimeout(this._copyT);
  }
}
