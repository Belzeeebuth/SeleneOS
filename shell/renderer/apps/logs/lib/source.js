// « Service ou application » filter: a combobox with suggestions (units and programs seen in the journal,
// journal:sources). Choosing a unit filters with -u, a program with -t; text typed by hand is guessed
// (guessSource). Keyboard: ↓ / ↑ move in the list, Enter chooses, Escape closes (then clears).
import { guessSource } from './format.js';

const MAX_SHOWN = 14;
let seq = 0;

export class SourceBox {
  /** opts: { onChange(source|null), getSources() -> Promise<{ units, identifiers }> } */
  constructor(app, opts) {
    this.app = app;
    this.o = opts;
    this.value = null;
    this.items = [];
    this.active = -1;
    this._req = 0;
    this.id = `lgsrc${++seq}`;
    const { h, icon, t } = app.ctx;
    this.input = h('input', {
      class: 'input lg-source-input',
      type: 'text',
      spellcheck: false,
      autocomplete: 'off',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': `${this.id}-list`,
      'aria-label': t('filter.source'),
      placeholder: t('filter.sourcePh'),
    });
    this.clearBtn = h('button', { class: 'lg-field-clear', type: 'button', tabindex: '-1', 'aria-label': t('filter.clearSource'), 'data-tip': t('filter.clearSource'), onclick: () => this.set(null, true) }, icon('x', { size: 12 }));
    this.list = h('div', { class: 'lg-suggest menu', id: `${this.id}-list`, role: 'listbox', hidden: true, 'aria-label': t('filter.source') });
    this.el = h('div', { class: 'lg-source' }, icon('puzzle-piece', { size: 14, class: 'lg-field-ic' }), this.input, this.clearBtn, this.list);
    this.input.addEventListener('input', () => {
      this.el.classList.toggle('has-text', !!this.input.value);
      this.open();
    });
    this.input.addEventListener('focus', () => this.input.select());
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('blur', () =>
      setTimeout(() => {
        if (this.el.contains(document.activeElement)) return;
        this.close();
        // Leaving the field: back to the chosen value (a half-typed name is not a filter).
        this.input.value = this.value?.value || '';
        this.el.classList.toggle('has-text', !!this.input.value);
      }, 120),
    );
    this.list.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the focus in the field
  }

  relabel() {
    const { t } = this.app.ctx;
    this.input.setAttribute('aria-label', t('filter.source'));
    this.input.placeholder = t('filter.sourcePh');
    this.clearBtn.setAttribute('aria-label', t('filter.clearSource'));
    this.clearBtn.dataset.tip = t('filter.clearSource');
    this.list.setAttribute('aria-label', t('filter.source'));
  }

  /** Show a value without telling anyone (filters restored, a view chosen); text being typed is left alone. */
  show(source, force = false) {
    this.value = source || null;
    if (!force && document.activeElement === this.input && !this.list.hidden) return;
    this.input.value = source?.value || '';
    this.el.classList.toggle('has-text', !!this.input.value);
    this.el.dataset.kind = source?.kind || '';
  }

  set(source, notify = false) {
    this.show(source, true);
    this.close();
    if (notify) this.o.onChange(this.value);
  }

  async open() {
    const n = ++this._req;
    const known = await this.o.getSources().catch(() => ({ units: [], identifiers: [] }));
    if (n !== this._req || this.app.closed) return;
    this.known = known;
    const q = this.input.value.trim().toLowerCase();
    const pick = (list, kind) =>
      list
        .filter((v) => !q || v.toLowerCase().includes(q))
        .sort((a, b) => (a.toLowerCase().startsWith(q) ? 0 : 1) - (b.toLowerCase().startsWith(q) ? 0 : 1) || a.localeCompare(b))
        .slice(0, MAX_SHOWN / 2)
        .map((value) => ({ kind, value }));
    const units = pick(known.units || [], 'unit');
    const ids = pick(known.identifiers || [], 'ident');
    this.items = [...units, ...ids];
    this.active = this.items.length ? 0 : -1;
    this.paint(units.length, ids.length);
  }

  paint(nUnits, nIds) {
    const { h, icon, t } = this.app.ctx;
    this.list.textContent = '';
    if (!this.items.length) {
      this.list.append(h('div', { class: 'menu-header' }, t('suggest.none')));
    }
    this.items.forEach((it, i) => {
      if (i === 0 && nUnits) this.list.append(h('div', { class: 'menu-header', role: 'presentation' }, t('suggest.units')));
      if (i === nUnits && nIds) this.list.append(h('div', { class: 'menu-header', role: 'presentation' }, t('suggest.identifiers')));
      this.list.append(
        h(
          'div',
          {
            class: ['menu-item', 'lg-suggest-item', i === this.active && 'active'],
            role: 'option',
            id: `${this.id}-o${i}`,
            'aria-selected': String(i === this.active),
            dataset: { kind: it.kind, value: it.value },
            onclick: () => this.choose(i),
          },
          icon(it.kind === 'unit' ? 'puzzle-piece' : 'app-window', { size: 14 }),
          h('span', { class: 'ellipsis' }, it.value),
        ),
      );
    });
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.moveActive(this.active);
  }

  moveActive(i) {
    this.active = i;
    const opts = [...this.list.querySelectorAll('[role=option]')];
    opts.forEach((o, k) => {
      o.classList.toggle('active', k === i);
      o.setAttribute('aria-selected', String(k === i));
    });
    if (i >= 0 && opts[i]) {
      this.input.setAttribute('aria-activedescendant', opts[i].id);
      opts[i].scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  close() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  choose(i) {
    const it = this.items[i];
    if (!it) return;
    this.set(it, true);
  }

  key(e) {
    const open = !this.list.hidden;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) return this.open();
      this.moveActive(Math.min(this.items.length - 1, this.active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) this.moveActive(Math.max(0, this.active - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const typed = this.input.value.trim();
      if (open && this.active >= 0 && this.items[this.active] && (!typed || this.items[this.active].value.toLowerCase().includes(typed.toLowerCase()))) return this.choose(this.active);
      if (!typed) return this.set(null, true);
      const g = guessSource(typed, this.known);
      if (g) this.set(g, true);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (this.input.value) {
        e.preventDefault();
        e.stopPropagation();
        this.set(null, true);
      }
    }
  }
}
