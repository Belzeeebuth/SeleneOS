// State shared by every Mail window (the module is loaded once per shell session):
// accounts, preferences and the address book used for recipient autocomplete.
//   prefs (ctx.storage 'prefs'): notifications, remoteImages ('ask'|'always'), trustedSenders[],
//          listWidth, navCollapsed, lastAccount, lastFolder, darkAdapt
//   contacts (ctx.storage 'contacts'): { address: { name, n (times seen), t (last seen ms) } }
import { Emitter } from '../../../core/api.js';
import { debounce, sameAddress } from './util.js';

const DEFAULT_PREFS = {
  notifications: true,
  remoteImages: 'ask',
  trustedSenders: [],
  listWidth: 380,
  navWidth: 252,
  navCollapsed: false,
  lastAccount: null,
  lastFolder: null,
  darkAdapt: false,
  collapsed: {},
};

class Store extends Emitter {
  constructor() {
    super();
    this.ready = null;
    this.ctx = null;
    this.prefs = { ...DEFAULT_PREFS };
    this.contacts = new Map();
    this.accounts = [];
    this.presets = [];
    this.storage = { secure: true, backend: '' };
    this._saveContacts = debounce(() => this.ctx?.storage.set('contacts', Object.fromEntries(this.contacts)).catch(() => {}), 1500);
    this._savePrefs = debounce(() => this.ctx?.storage.set('prefs', this.prefs).catch(() => {}), 300);
  }

  init(ctx) {
    if (!this.ctx) this.ctx = ctx;
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const { api, storage } = ctx;
      const [prefs, contacts, presets, mode] = await Promise.all([
        storage.get('prefs', null).catch(() => null),
        storage.get('contacts', null).catch(() => null),
        api.invoke('mail:presets').catch(() => []),
        api.invoke('mail:storage').catch(() => ({ secure: true })),
      ]);
      this.prefs = { ...DEFAULT_PREFS, ...(prefs || {}) };
      for (const [k, v] of Object.entries(contacts || {})) if (v && typeof v === 'object') this.contacts.set(k, v);
      this.presets = presets;
      this.storage = mode;
      await this.loadAccounts();
    })();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  async loadAccounts() {
    this.accounts = await this.ctx.api.invoke('mail:accounts');
    this.emit('accounts', this.accounts);
    return this.accounts;
  }

  account(id) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  preset(id) {
    return this.presets.find((p) => p.id === id) || this.presets.find((p) => p.id === 'other') || { id: 'other', name: 'Other', color: '#5c5c5c', fg: '#fff', mono: '@' };
  }

  setPref(key, value) {
    this.prefs[key] = value;
    this._savePrefs();
    this.emit('prefs', key, value);
  }

  isTrustedSender(address) {
    return (this.prefs.trustedSenders || []).some((a) => sameAddress(a, address));
  }

  trustSender(address, on = true) {
    const list = (this.prefs.trustedSenders || []).filter((a) => !sameAddress(a, address));
    if (on && address) list.push(String(address).toLowerCase());
    this.setPref('trustedSenders', list);
  }

  // ------------------------------------------------------------ address book
  addContacts(list, weight = 1) {
    const now = Date.now();
    let changed = false;
    for (const a of list || []) {
      const address = String(a?.address || '').trim().toLowerCase();
      if (!address || !address.includes('@') || address.length > 200 || /no-?reply|mailer-daemon|notifications?@/i.test(address)) continue;
      if (this.accounts.some((acc) => sameAddress(acc.email, address))) continue;
      const cur = this.contacts.get(address) || { name: '', n: 0, t: 0 };
      const name = String(a.name || '').trim();
      if (name && name !== address && name.length < 120) cur.name = name;
      cur.n = Math.min(10000, (cur.n || 0) + weight);
      cur.t = Math.max(cur.t || 0, now);
      this.contacts.set(address, cur);
      changed = true;
    }
    if (this.contacts.size > 3000) {
      const sorted = [...this.contacts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].t - a[1].t).slice(0, 2500);
      this.contacts = new Map(sorted);
    }
    if (changed) this._saveContacts();
  }

  suggest(query, exclude = [], limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const ex = new Set(exclude.map((x) => String(x).toLowerCase()));
    const out = [];
    for (const [address, c] of this.contacts) {
      if (ex.has(address)) continue;
      const name = (c.name || '').toLowerCase();
      let score = 0;
      if (address.startsWith(q)) score = 3;
      else if (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) score = 3;
      else if (address.includes(q) || name.includes(q)) score = 1;
      if (score) out.push({ address, name: c.name || '', score: score * 1000 + Math.min(999, c.n) + c.t / 1e13 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export const store = new Store();
