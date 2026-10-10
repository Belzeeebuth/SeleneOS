// Recipient field: address chips with autocomplete from previously seen addresses.
//   const f = new AddressField(ctx, { label: 'To', name: 'to', value: [{name, address}], onChange });
//   f.el ; f.value -> [{name, address}] ; f.invalid -> [chips that are not e-mail addresses] ; f.focus()
import { store } from './store.js';
import { avatarColor, initials, isEmail, parseAddresses, addressText } from './util.js';

export class AddressField {
  constructor(ctx, { label, name, value = [], onChange, extra }) {
    this.ctx = ctx;
    this.name = name;
    this.onChange = onChange;
    this.chips = [];
    this.suggestions = [];
    this.active = -1;
    const { h } = ctx;
    this.input = h('input', { class: 'ml-chip-input', type: 'text', name, autocomplete: 'off', spellcheck: false, 'aria-label': label, 'aria-autocomplete': 'list' });
    this.box = h('div', { class: 'ml-chips', onclick: (e) => e.target === this.box && this.input.focus() }, this.input);
    this.popup = h('div', { class: 'ml-suggest', role: 'listbox', hidden: true });
    this.el = h('div', { class: 'ml-field ml-addr', dataset: { field: name } }, h('label', { class: 'ml-field-label', onclick: () => this.input.focus() }, label), this.box, extra || null, this.popup);
    for (const a of value) this.add(a, { silent: true });
    this.wire();
  }

  get value() {
    const pending = this.input.value.trim();
    const list = this.chips.map((c) => ({ name: c.name, address: c.address }));
    if (pending) for (const a of parseAddresses(pending)) list.push(a);
    return list;
  }

  get invalid() {
    return this.value.filter((a) => !isEmail(a.address));
  }

  focus() {
    this.input.focus();
  }

  set(list) {
    for (const c of this.chips) c.el.remove();
    this.chips = [];
    for (const a of list || []) this.add(a, { silent: true });
  }

  add(a, { silent } = {}) {
    const { h, icon, t } = this.ctx;
    const address = String(a.address || '').trim();
    if (!address) return;
    if (this.chips.some((c) => c.address.toLowerCase() === address.toLowerCase())) return;
    const known = store.contacts.get(address.toLowerCase());
    const chip = { name: a.name || known?.name || '', address, valid: isEmail(address) };
    const label = chip.name || chip.address;
    chip.el = h(
      'span',
      { class: ['ml-chip', !chip.valid && 'invalid'], tabindex: '-1', role: 'button', title: chip.valid ? addressText(chip) : t('compose.invalidAddress', { address }), dataset: { address } },
      h('span', { class: 'ml-chip-avatar', style: { background: avatarColor(address) } }, initials(chip.name, address)),
      h('span', { class: 'ml-chip-label' }, label),
      h('button', { class: 'ml-chip-x', type: 'button', tabindex: '-1', 'aria-label': t('compose.removeRecipient'), onclick: (e) => (e.stopPropagation(), this.remove(chip)) }, icon('dismiss', { size: 10 })),
    );
    chip.el.addEventListener('click', (e) => {
      e.stopPropagation();
      chip.el.focus();
    });
    chip.el.addEventListener('dblclick', () => this.edit(chip));
    chip.el.addEventListener('contextmenu', (e) => this.chipMenu(e, chip));
    chip.el.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const i = this.chips.indexOf(chip);
        this.remove(chip);
        (this.chips[Math.max(0, i - 1)]?.el || this.input).focus();
      } else if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        this.edit(chip);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.chips[this.chips.indexOf(chip) - 1]?.el.focus();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        (this.chips[this.chips.indexOf(chip) + 1]?.el || this.input).focus();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
        this.input.focus();
      }
    });
    this.chips.push(chip);
    this.box.insertBefore(chip.el, this.input);
    if (!silent) this.onChange?.();
  }

  remove(chip) {
    chip.el.remove();
    this.chips = this.chips.filter((c) => c !== chip);
    this.onChange?.();
  }

  edit(chip) {
    this.commit();
    this.remove(chip);
    this.input.value = addressText(chip);
    this.input.focus();
    this.input.select();
  }

  async chipMenu(e, chip) {
    const { ui, t } = this.ctx;
    await ui.menu(e, [
      { label: t('compose.editRecipient'), icon: 'edit', action: () => this.edit(chip) },
      { label: t('compose.copyAddress'), icon: 'copy', action: () => this.ctx.api.invoke('clipboard:writeText', chip.address).catch(() => {}) },
      '-',
      { label: t('compose.removeRecipient'), icon: 'dismiss', action: () => this.remove(chip) },
    ]);
  }

  // Turn the typed text into chips.
  commit() {
    const text = this.input.value.trim();
    if (!text) return false;
    for (const a of parseAddresses(text)) this.add(a);
    this.input.value = '';
    this.closePopup();
    return true;
  }

  wire() {
    const inp = this.input;
    inp.addEventListener('input', () => {
      const v = inp.value;
      if (/[,;]\s*$/.test(v) && v.replace(/[,;\s]/g, '')) {
        this.commit();
        return;
      }
      this.updateSuggestions();
      this.onChange?.();
    });
    inp.addEventListener('keydown', (e) => {
      const open = !this.popup.hidden && this.suggestions.length;
      if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.suggestions.length) % this.suggestions.length;
        this.renderPopup();
        return;
      }
      if (e.key === 'Enter' && !e.ctrlKey) {
        if (open && this.active >= 0) {
          e.preventDefault();
          this.pick(this.suggestions[this.active]);
          return;
        }
        if (inp.value.trim()) {
          e.preventDefault();
          this.commit();
        }
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey && inp.value.trim()) {
        if (open && this.active >= 0) this.pick(this.suggestions[this.active]);
        else this.commit();
        return; // let the focus move on
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();
        this.closePopup();
        return;
      }
      if (e.key === 'Backspace' && !inp.value && this.chips.length) {
        e.preventDefault();
        this.chips[this.chips.length - 1].el.focus();
        return;
      }
      if (e.key === 'ArrowLeft' && inp.selectionStart === 0 && this.chips.length) {
        e.preventDefault();
        this.chips[this.chips.length - 1].el.focus();
      }
    });
    inp.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') || '';
      if (/[,;\n]/.test(text) || (text.includes('@') && !inp.value)) {
        e.preventDefault();
        inp.value += text;
        this.commit();
      }
    });
    inp.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement === inp) return;
        this.commit();
        this.closePopup();
      }, 150);
    });
  }

  updateSuggestions() {
    const q = this.input.value.trim();
    this.suggestions = q.length >= 1 ? store.suggest(q, this.chips.map((c) => c.address)) : [];
    this.active = this.suggestions.length ? 0 : -1;
    this.renderPopup();
  }

  renderPopup() {
    const { h, ui } = this.ctx;
    ui.clear(this.popup);
    if (!this.suggestions.length) {
      this.popup.hidden = true;
      return;
    }
    this.popup.hidden = false;
    this.suggestions.forEach((s, i) => {
      this.popup.appendChild(
        h(
          'div',
          {
            class: ['ml-suggest-item', i === this.active && 'active'],
            role: 'option',
            'aria-selected': String(i === this.active),
            onpointerdown: (e) => {
              e.preventDefault();
              this.pick(s);
            },
            onpointerenter: () => {
              this.active = i;
              this.popup.querySelectorAll('.ml-suggest-item').forEach((el, j) => el.classList.toggle('active', j === i));
            },
          },
          h('span', { class: 'ml-avatar sm', style: { background: avatarColor(s.address) } }, initials(s.name, s.address)),
          h('span', { class: 'grow ml-suggest-text' }, h('span', { class: 'ellipsis' }, s.name || s.address), s.name ? h('span', { class: 'caption text-2 ellipsis' }, s.address) : null),
        ),
      );
    });
  }

  pick(s) {
    this.input.value = '';
    this.add({ name: s.name, address: s.address });
    this.closePopup();
    this.input.focus();
  }

  closePopup() {
    this.popup.hidden = true;
    this.suggestions = [];
    this.active = -1;
  }
}
