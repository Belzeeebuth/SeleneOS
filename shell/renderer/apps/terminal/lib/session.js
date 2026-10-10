// One terminal: an xterm.js instance wired to a PTY (main/ipc/pty.js). Lives in a pane.
//   const s = new Session(app, profile, { cwd, command });  pane.appendChild(s.el);  await s.start();
//   s.title  s.busy  s.copy()  s.paste()  s.selectAll()  s.clear()  s.fitSoon()  s.dispose()
import { bus } from './bus.js';
import { installUnicode } from './unicode.js';

const XTERM = 'app://shell/node_modules/@xterm/xterm/lib/xterm.mjs';
const FIT = 'app://shell/node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
const LINKS = 'app://shell/node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
const CSS = 'app://shell/node_modules/@xterm/xterm/css/xterm.css';

let libs = null;
export function loadXterm(ui) {
  ui.loadCss(CSS);
  if (!libs) {
    libs = Promise.all([import(XTERM), import(FIT), import(LINKS)]).then(([x, f, l]) => ({
      Terminal: x.Terminal,
      FitAddon: f.FitAddon,
      WebLinksAddon: l.WebLinksAddon,
    }));
    libs.catch(() => (libs = null));
  }
  return libs;
}

let seq = 0;

export class Session {
  constructor(app, profile, { cwd = null, command = null } = {}) {
    this.app = app;
    this.ctx = app.ctx;
    this.id = `s${++seq}`;
    this.profile = profile;
    this.cwd = cwd;
    this.command = command; // overrides profile.command (string: run by the shell)
    this.ptyId = null;
    this.state = 'new'; // new | running | exited (waiting for Enter/Ctrl+D) | closed
    this.exitCode = null;
    this.oscTitle = '';
    this.proc = { name: '', busy: false }; // foreground program (main/ipc/pty.js 'pty:proc')
    this.pane = null;
    this.el = this.ctx.h('div', { class: 'tm-term', dataset: { session: this.id } });
    this.bellEl = this.ctx.h('div', { class: 'tm-bell', 'aria-hidden': 'true' });
    this.linkTip = null;
    this.disposed = false;
    this._fitTimer = 0;
    this._selTimer = 0;
    this._ptySize = ''; // the size the PTY was last told
    this._offs = [];
  }

  get api() {
    return this.ctx.api;
  }

  // Windows Terminal: the title a program sets (OSC 0/2); else the program running in the
  // foreground; else the profile name. (Aurora's bash prompt titles the tab with the running command.)
  get title() {
    const p = this.proc;
    return this.oscTitle || (p.busy && p.name) || this.commandLabel || this.profile.name;
  }

  // A command given at launch ({ command: 'htop' }) rather than the profile's interactive shell.
  get commandLabel() {
    return typeof this.command === 'string' && this.command.trim() ? this.command.trim().slice(0, 60) : '';
  }

  // A program other than the interactive shell is running (closing would stop it).
  get busy() {
    return this.state === 'running' && (this.proc.busy || !!this.commandLabel);
  }

  get busyName() {
    return (this.proc.busy && this.proc.name) || this.commandLabel || this.proc.name || this.profile.name;
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    const { Terminal, FitAddon, WebLinksAddon } = await loadXterm(this.ctx.ui);
    if (this.disposed) return;
    const term = new Terminal({ ...this.app.termOptions(), allowProposedApi: true, allowTransparency: true });
    this.term = term;
    installUnicode(term);
    this.fit = new FitAddon();
    term.loadAddon(this.fit);
    term.loadAddon(
      new WebLinksAddon((e, uri) => this.app.openLink(e, uri), {
        hover: (e, uri) => this.showLinkTip(e, uri),
        leave: () => this.hideLinkTip(),
      }),
    );
    term.open(this.el);
    this.el.appendChild(this.bellEl);
    term.textarea?.setAttribute('aria-label', this.profile.name);
    this.fitNow();

    this._offs.push(
      term.onData((d) => this.input(d)),
      term.onBinary((d) => this.ptyId && this.state === 'running' && this.api.send('pty:write', this.ptyId, d, 'binary')),
      term.onResize(({ cols, rows }) => this.ptyResize(cols, rows)),
      term.onTitleChange((title) => {
        this.oscTitle = String(title || '').slice(0, 200);
        this.app.sessionTitleChanged(this);
      }),
      term.onBell(() => this.app.bell(this)),
      term.onSelectionChange(() => this.selectionChanged()),
    );
    term.textarea?.addEventListener('focus', () => this.app.sessionFocused(this));

    this.ro = new ResizeObserver(() => this.fitSoon());
    this.ro.observe(this.el);
    await this.spawn();
  }

  async spawn() {
    const { api } = this;
    const command = this.command ?? this.profile.command ?? null;
    this.fitNow();
    this._ptySize = `${this.term.cols}x${this.term.rows}`;
    try {
      this.ptyId = await api.invoke('pty:spawn', { cols: this.term.cols, rows: this.term.rows, cwd: this.cwd || this.app.startDir(), command });
    } catch (err) {
      this.state = 'exited';
      this.exitCode = -1;
      this.term.write(`\x1b[31m${this.ctx.t('error.spawn', { message: err.message })}\x1b[0m\r\n`);
      this.app.sessionTitleChanged(this);
      return;
    }
    if (this.disposed) {
      api.invoke('pty:kill', this.ptyId).catch(() => {});
      return;
    }
    this.state = 'running';
    this.exitCode = null;
    bus.register(this.ptyId, this);
    // The window may have been resized while the PTY started.
    this.ptyResize(this.term.cols, this.term.rows);
    this.app.sessionTitleChanged(this);
  }

  input(data) {
    if (this.state === 'running' && this.ptyId) {
      this.api.send('pty:write', this.ptyId, data);
      return;
    }
    if (this.state === 'exited') {
      // Windows Terminal: "press Enter to restart, Ctrl+D to close".
      if (data === '\r') this.restart();
      else if (data === '\x04') this.app.closeSession(this, { force: true });
    }
  }

  restart() {
    if (this.state !== 'exited' || this.disposed) return;
    this.state = 'new';
    this.oscTitle = '';
    this.proc = { name: '', busy: false };
    this.term.write('\r\n');
    this.spawn();
  }

  ptyResize(cols, rows) {
    if (!this.ptyId || this.state !== 'running') return;
    const size = `${cols}x${rows}`;
    if (size === this._ptySize) return;
    this._ptySize = size;
    this.api.invoke('pty:resize', this.ptyId, cols, rows).catch(() => {});
  }

  // ------------------------------------------------------------------ PTY events (lib/bus.js)
  onPtyData(data) {
    if (this.disposed) return;
    const id = this.ptyId;
    this.term.write(data, () => this.api.send('pty:ack', id, data.length));
  }

  onPtyExit(code) {
    bus.unregister(this.ptyId);
    if (this.disposed || this.state === 'closed') return;
    this.state = 'exited';
    this.exitCode = code;
    this.proc = { name: '', busy: false };
    const mode = this.app.prefs.get('closeOnExit');
    if (mode === 'always' || (mode === 'graceful' && code === 0)) {
      this.app.closeSession(this, { force: true });
      return;
    }
    const { t } = this.ctx;
    const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    this.term.write(`\r\n\x1b[0m\x1b[90m${t('exit.code', { code, hex })}\x1b[0m\r\n\x1b[90m${t('exit.hint')}\x1b[0m`);
    this.app.sessionTitleChanged(this);
  }

  onPtyProc({ name, busy }) {
    this.proc = { name: name || '', busy: !!busy };
    this.app.sessionTitleChanged(this);
  }

  // ------------------------------------------------------------------ sizing
  fitNow() {
    if (!this.term || this.disposed) return;
    if (!this.el.isConnected || this.el.offsetWidth < 20 || this.el.offsetHeight < 10) return;
    try {
      this.fit.fit();
    } catch (err) {
      console.warn('[terminal] fit failed', err);
    }
  }

  fitSoon(delay = 40) {
    clearTimeout(this._fitTimer);
    this._fitTimer = setTimeout(() => this.fitNow(), delay);
  }

  applyOptions(opts) {
    if (!this.term) return;
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'theme' || this.term.options[k] !== v) this.term.options[k] = v;
    }
    this.fitSoon(0);
  }

  // ------------------------------------------------------------------ clipboard & selection
  hasSelection() {
    return !!this.term?.hasSelection();
  }

  async copy() {
    const text = this.term?.getSelection();
    if (!text) return false;
    await this.api.invoke('clipboard:writeText', text).catch((err) => this.app.error(err));
    return true;
  }

  async paste(text) {
    if (!this.term || this.state !== 'running') return;
    if (text == null) {
      try {
        text = await this.api.invoke('clipboard:readText');
      } catch (err) {
        this.app.error(err);
        return;
      }
    }
    if (!text) return;
    if (this.app.prefs.get('warnPaste') && /[\r\n]/.test(text.replace(/[\r\n]+$/, '')) && !this.term.modes.bracketedPasteMode) {
      if (!(await this.app.confirmPaste(text))) return;
    }
    this.term.paste(text);
    this.term.focus();
  }

  selectionChanged() {
    clearTimeout(this._selTimer);
    this._selTimer = setTimeout(() => {
      const text = this.term?.getSelection();
      if (!text) return;
      this.api.invoke('pty:primaryWrite', text).catch(() => {});
      if (this.app.prefs.get('copyOnSelect')) this.api.invoke('clipboard:writeText', text).catch(() => {});
    }, 120);
  }

  selectAll() {
    this.term?.selectAll();
  }

  clear() {
    if (!this.term) return;
    this.term.clear();
    // Let the shell redraw its prompt on the now empty screen.
    if (this.state === 'running' && !this.busy) this.api.send('pty:write', this.ptyId, '\x0c');
  }

  focus() {
    if (!this.disposed) this.term?.focus();
  }

  // ------------------------------------------------------------------ visuals
  flashBell() {
    if (document.documentElement.dataset.animations === 'off') {
      this.bellEl.classList.add('on');
      setTimeout(() => this.bellEl.classList.remove('on'), 120);
      return;
    }
    this.bellEl.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 320, easing: 'ease-out' });
  }

  showLinkTip(e, uri) {
    this.hideLinkTip();
    const { h, t } = this.ctx;
    const tip = h('div', { class: 'tm-linktip' }, h('div', { class: 'tm-linktip-url' }, uri.length > 120 ? `${uri.slice(0, 117)}…` : uri), h('div', { class: 'tm-linktip-hint' }, t('link.hint')));
    this.linkTip = tip;
    this.app.root.appendChild(tip);
    const host = this.app.root.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    const x = Math.max(4, Math.min(host.width - r.width - 4, e.clientX - host.left - r.width / 2));
    let y = e.clientY - host.top - r.height - 14;
    if (y < 4) y = e.clientY - host.top + 18;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  hideLinkTip() {
    this.linkTip?.remove();
    this.linkTip = null;
  }

  // ------------------------------------------------------------------ teardown
  kill() {
    if (this.ptyId && this.state === 'running') this.api.invoke('pty:kill', this.ptyId).catch(() => {});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.kill();
    this.state = 'closed';
    if (this.ptyId) bus.unregister(this.ptyId);
    clearTimeout(this._fitTimer);
    clearTimeout(this._selTimer);
    this.ro?.disconnect();
    this.hideLinkTip();
    for (const d of this._offs) d?.dispose?.();
    try {
      this.term?.dispose();
    } catch {}
    this.el.remove();
  }
}
