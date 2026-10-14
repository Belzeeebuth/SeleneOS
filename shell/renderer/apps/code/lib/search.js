// « Rechercher dans les fichiers » (Ctrl+Shift+F) of the Code Editor: a view of the side panel.
//   Query with « Respecter la casse », « Mot entier », « Expression régulière »; files to include / exclude (globs);
//   .gitignore and node_modules skipped unless turned off. The search runs in the backend (main/ipc/code-search.js
//   code:search) inside the opened folder only, streams its results (code:search-batch) and can be stopped; open
//   documents are searched as they are in the editor (their unsaved text is sent along).
//   Results are grouped by file, with the line, the match highlighted and, when replacing, the new text; a click
//   opens the file at the match. A match or a file can be set aside (« Écarter ») before replacing.
//   Replace: one match, one file, or « Remplacer tout » (after a confirmation). Files open in the editor change in
//   their buffer (Ctrl+Z there undoes it; saved at once when they had no unsaved change), the others on disk through
//   the backend, which checks they did not change since the search. « Annuler le remplacement » undoes the last one.
// Test hooks: panel.testDelay (ms per file, dev backends only), panel.results, panel.summary, panel.status.
const DEBOUNCE = 300;

export class SearchPanel {
  constructor(app) {
    this.app = app;
    this.h = app.h;
    this.t = app.t;
    const { h, t } = app;
    const saved = app.prefs.search || {};
    this.opts = {
      query: '',
      replace: '',
      matchCase: !!saved.matchCase,
      wholeWord: !!saved.wholeWord,
      regex: !!saved.regex,
      include: typeof saved.include === 'string' ? saved.include : '',
      exclude: typeof saved.exclude === 'string' ? saved.exclude : '',
      useIgnore: saved.useIgnore !== false,
      showReplace: !!saved.showReplace,
      showFilters: !!saved.showFilters,
    };
    this.results = [];
    this.summary = null;
    this.status = 'idle'; // idle | running | done | error
    this.error = '';
    this.message = '';
    this.undo = null;
    this.seq = 0;
    this.searchId = null;
    this.searched = null;
    this.versions = new Map();
    this.testDelay = 0;
    this.off = app.api.on('code:search-batch', (p) => p && p.id === this.searchId && this.add(p.results || []));

    const icon = (n, size = 16) => app.icon(n, { size });
    const toggle = (key, ic, tip, act) => {
      const b = h('button', { class: 'code-sopt', 'data-tip': tip, 'aria-label': tip, 'data-act': act, onclick: () => this.setOpt(key, !this.opts[key]) }, icon(ic));
      b.dataset.key = key;
      return b;
    };
    this.queryInput = h('input', { class: 'input', name: 'query', type: 'text', placeholder: t('searchPlaceholder'), 'aria-label': t('searchPlaceholder'), spellcheck: 'false', autocomplete: 'off' });
    this.queryInput.addEventListener('input', () => {
      this.opts.query = this.queryInput.value;
      this.schedule();
    });
    this.optBtns = [
      toggle('matchCase', 'text-aa', `${t('matchCase')} (Alt+C)`, 'opt-case'),
      toggle('wholeWord', 'text-a-underline', `${t('wholeWord')} (Alt+W)`, 'opt-word'),
      toggle('regex', 'asterisk', `${t('regex')} (Alt+R)`, 'opt-regex'),
    ];
    this.replaceInput = h('input', { class: 'input', name: 'replace', type: 'text', placeholder: t('replacePlaceholder'), 'aria-label': t('replacePlaceholder'), spellcheck: 'false', autocomplete: 'off' });
    this.replaceInput.addEventListener('input', () => {
      this.opts.replace = this.replaceInput.value;
      // a regular expression's replacement ($1…) comes from the search: search again; a plain text is shown as is
      if (this.opts.regex) this.schedule();
      else this.renderResults();
    });
    this.replaceAllBtn = h('button', { class: 'btn small', 'data-act': 'replace-all', onclick: () => this.replaceAll() }, t('replaceAll'));
    this.expandBtn = h('button', { class: 'code-sexpand', 'data-act': 'toggle-replace', 'data-tip': t('toggleReplace'), 'aria-label': t('toggleReplace'), onclick: () => this.setOpt('showReplace', !this.opts.showReplace) });
    this.replaceRow = h('div', { class: 'code-sfield code-sreplace' }, this.replaceInput);
    this.replaceActions = h('div', { class: 'code-sactions' }, this.replaceAllBtn);
    this.includeInput = h('input', { class: 'input', name: 'include', type: 'text', placeholder: t('includePh'), spellcheck: 'false', autocomplete: 'off' });
    this.excludeInput = h('input', { class: 'input', name: 'exclude', type: 'text', placeholder: t('excludePh'), spellcheck: 'false', autocomplete: 'off' });
    for (const [inp, key] of [
      [this.includeInput, 'include'],
      [this.excludeInput, 'exclude'],
    ]) {
      inp.addEventListener('input', () => {
        this.opts[key] = inp.value;
        this.saveOpts();
        this.schedule(500);
      });
    }
    this.ignoreBox = h('input', { type: 'checkbox', name: 'useIgnore', onchange: () => this.setOpt('useIgnore', this.ignoreBox.checked) });
    this.filtersBtn = h('button', { class: 'btn subtle code-tbtn code-sfilters-btn', 'data-act': 'toggle-filters', 'data-tip': t('toggleFilters'), 'aria-label': t('toggleFilters'), onclick: () => this.setOpt('showFilters', !this.opts.showFilters) }, icon('dots-three'));
    this.filters = h(
      'div',
      { class: 'code-sfilters' },
      h('label', { class: 'code-slabel' }, h('span', null, t('include')), this.includeInput),
      h('label', { class: 'code-slabel' }, h('span', null, t('exclude')), this.excludeInput),
      h('label', { class: 'checkbox code-signore' }, this.ignoreBox, h('span', null, t('useIgnore'))),
    );
    this.statusText = h('span', { class: 'code-sstatus-text' });
    this.stopBtn = h('button', { class: 'btn small', 'data-act': 'search-stop', onclick: () => this.cancel() }, icon('stop', 14), t('stop'));
    this.undoBtn = h('button', { class: 'btn small', 'data-act': 'replace-undo', onclick: () => this.undoReplace() }, icon('arrow-counter-clockwise', 14), t('undoReplace'));
    this.statusEl = h('div', { class: 'code-sstatus', role: 'status', 'aria-live': 'polite' }, this.statusText, this.stopBtn, this.undoBtn);
    this.list = h('div', { class: 'code-slist', role: 'tree', tabindex: 0, 'aria-label': t('searchResults'), onkeydown: (e) => this.listKey(e) });
    this.list.addEventListener('focus', (e) => {
      if (e.target === this.list) this.rows()[0]?.focus();
    });
    this.empty = h('div', { class: 'code-sempty' });
    const headBtn = (ic, tip, onclick, act) => h('button', { class: 'btn subtle code-tbtn', 'data-tip': tip, 'aria-label': tip, 'data-act': act, onclick }, icon(ic, 18));
    this.el = h(
      'div',
      { class: 'code-search', role: 'region', 'aria-label': t('searchTitle'), onkeydown: (e) => this.keys(e) },
      h(
        'div',
        { class: 'code-side-head' },
        h('div', { class: 'code-side-title', title: t('searchTitle') }, t('searchHead')),
        h(
          'div',
          { class: 'code-side-actions' },
          headBtn('arrow-clockwise', t('refreshSearch'), () => this.run(), 'search-refresh'),
          headBtn('x-circle', t('clearSearch'), () => this.clear(), 'search-clear'),
          headBtn('arrows-in-simple', t('collapseResults'), () => this.collapseAll(), 'search-collapse'),
        ),
      ),
      h(
        'div',
        { class: 'code-sform' },
        h('div', { class: 'code-srow' }, this.expandBtn, h('div', { class: 'code-sfields' }, h('div', { class: 'code-sfield code-squery' }, this.queryInput, h('span', { class: 'code-sopts' }, this.optBtns)), this.replaceRow, this.replaceActions)),
        h('div', { class: 'code-sfilters-row' }, this.filtersBtn),
        this.filters,
      ),
      this.statusEl,
      this.list,
      this.empty,
    );
    this.syncControls();
    this.renderStatus();
  }

  dispose() {
    this.off?.();
    this.cancel();
    clearTimeout(this.timer);
  }

  saveOpts() {
    const { query, replace, ...keep } = this.opts;
    this.app.prefs.search = keep;
    this.app.savePrefs();
  }

  syncControls() {
    const o = this.opts;
    if (this.queryInput.value !== o.query) this.queryInput.value = o.query;
    if (this.replaceInput.value !== o.replace) this.replaceInput.value = o.replace;
    this.includeInput.value = o.include;
    this.excludeInput.value = o.exclude;
    this.ignoreBox.checked = o.useIgnore;
    for (const b of this.optBtns) {
      const on = !!o[b.dataset.key];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.replaceRow.hidden = this.replaceActions.hidden = !o.showReplace;
    this.expandBtn.replaceChildren(this.app.icon(o.showReplace ? 'caret-down' : 'caret-right', { size: 14 }));
    this.expandBtn.setAttribute('aria-expanded', String(o.showReplace));
    this.filters.hidden = !o.showFilters;
    this.filtersBtn.classList.toggle('on', o.showFilters);
    this.filtersBtn.setAttribute('aria-expanded', String(o.showFilters));
    this.el.classList.toggle('replacing', !!o.showReplace);
  }

  setOpt(key, value) {
    this.opts[key] = value;
    this.syncControls();
    this.saveOpts();
    if (key === 'showFilters') return;
    if (key === 'showReplace') {
      if (value) setTimeout(() => this.replaceInput.focus(), 0);
      // the preview of the replacement needs it in the search (regular expressions): search again
      if (this.opts.regex && this.opts.replace) this.schedule(0);
      else this.renderResults();
      return;
    }
    this.schedule(0);
  }

  /** Sets the query (and options) and searches now. */
  async search(query, opts = {}) {
    Object.assign(this.opts, opts, { query: String(query ?? '') });
    this.syncControls();
    this.saveOpts();
    return this.run();
  }

  focus({ replace = false } = {}) {
    if (replace && !this.opts.showReplace) this.setOpt('showReplace', true);
    const inp = replace ? this.replaceInput : this.queryInput;
    inp.focus();
    inp.select();
  }

  schedule(ms = DEBOUNCE) {
    clearTimeout(this.timer);
    this.pending = true;
    this.renderStatus();
    this.timer = setTimeout(() => {
      this.pending = false;
      this.run();
    }, ms);
  }

  keys(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) {
      if (e.key === 'Enter' && e.target === this.queryInput) {
        e.preventDefault();
        clearTimeout(this.timer);
        this.pending = false;
        this.run();
      } else if (e.key === 'Enter' && e.target === this.replaceInput && (e.ctrlKey || e.metaKey) && e.altKey) {
        e.preventDefault();
        this.replaceAll();
      }
      return;
    }
    const k = e.code === 'KeyC' ? 'matchCase' : e.code === 'KeyW' ? 'wholeWord' : e.code === 'KeyR' ? 'regex' : null;
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    this.setOpt(k, !this.opts[k]);
  }

  cancel() {
    if (this.status === 'running' && this.searchId) this.app.api.invoke('code:searchCancel', this.searchId).catch(() => {});
  }

  clear() {
    clearTimeout(this.timer);
    this.pending = false;
    this.cancel();
    this.searchId = null;
    this.opts.query = '';
    this.results = [];
    this.summary = null;
    this.status = 'idle';
    this.message = '';
    this.undo = null;
    this.syncControls();
    this.renderResults();
    this.renderStatus();
    this.queryInput.focus();
  }

  collapseAll() {
    for (const f of this.results) f.open = false;
    this.renderResults();
  }

  /** The folder changed: forget the results. */
  reset() {
    this.cancel();
    this.searchId = null;
    this.results = [];
    this.summary = null;
    this.status = 'idle';
    this.message = '';
    this.undo = null;
    this.renderResults();
    this.renderStatus();
  }

  async run({ keepMessage = false } = {}) {
    const { app } = this;
    clearTimeout(this.timer);
    this.pending = false;
    this.cancel();
    if (!keepMessage) {
      this.message = '';
      this.undo = null;
    }
    const o = this.opts;
    if (!app.folder || !o.query) {
      this.searchId = null;
      this.results = [];
      this.summary = null;
      this.status = 'idle';
      this.renderResults();
      this.renderStatus();
      return null;
    }
    const id = `cs${Date.now().toString(36)}-${++this.seq}`;
    this.searchId = id;
    this.results = [];
    this.summary = null;
    this.status = 'running';
    this.error = '';
    const { buffers, versions } = app.openBuffers();
    this.versions = versions;
    this.searched = { query: o.query, replace: o.replace, regex: o.regex, matchCase: o.matchCase, wholeWord: o.wholeWord };
    this.renderResults();
    this.renderStatus();
    let res = null;
    try {
      res = await app.api.invoke('code:search', app.folder, {
        id,
        query: o.query,
        regex: o.regex,
        matchCase: o.matchCase,
        wholeWord: o.wholeWord,
        include: o.include,
        exclude: o.exclude,
        useIgnore: o.useIgnore,
        replace: o.regex ? o.replace : undefined,
        buffers,
        delayMs: this.testDelay || undefined,
      });
    } catch (err) {
      if (this.searchId !== id) return null;
      this.status = 'error';
      this.error = err.code === 'EREGEX' ? this.app.t('badRegex', { error: String(err.message).replace(/^Invalid regular expression: /, '') }) : this.app.t('searchFailed', { error: err.message });
      this.renderStatus();
      return null;
    }
    if (this.searchId !== id) return null;
    this.summary = res;
    this.status = 'done';
    // matches of the batches that arrived after the answer (they are sent first: just in case)
    await new Promise((r) => setTimeout(r, 0));
    this.renderStatus();
    if (!this.results.length) this.renderResults();
    return res;
  }

  add(results) {
    for (const r of results) {
      const f = { ...r, open: true, dismissed: new Set() };
      this.results.push(f);
      this.list.append(this.fileNode(f));
    }
    this.empty.hidden = true;
    this.renderStatus();
  }

  // ---------------------------------------------------------------- rendering
  counts() {
    let matches = 0;
    let files = 0;
    for (const f of this.results) {
      const n = f.matches.length - f.dismissed.size;
      if (n > 0) {
        files++;
        matches += n;
      }
    }
    return { matches, files };
  }

  renderStatus() {
    const { t } = this.app;
    const { matches, files } = this.counts();
    const s = this.summary;
    const lines = [];
    const sum = () => t('resultsIn', { results: t('resultCount', { count: matches }), files: t('fileCount', { count: files }) });
    if (!this.app.folder) lines.push(t('searchNoFolder'));
    else if (this.status === 'running') lines.push(matches ? `${t('searching')} ${sum()}` : t('searching'));
    else if (this.status === 'error') lines.push(this.error);
    else if (this.status === 'done') {
      if (s?.cancelled) lines.push(`${t('searchStopped')} ${sum()}`);
      else if (!matches) lines.push(t('noResults'));
      else lines.push(sum());
      if (s?.limitHit) lines.push(t('limitHit', { count: (s.matches || matches).toLocaleString(this.app.uiLang()) }));
      if (s?.timedOut) lines.push(t('searchTimedOut'));
      const skipped = (s?.skipped?.binary || 0) + (s?.skipped?.large || 0);
      if (skipped) lines.push(t('skipped', { count: skipped }));
    }
    if (this.message) lines.push(this.message);
    this.statusText.replaceChildren(...lines.map((l) => this.app.h('span', { class: 'code-sline' }, l)));
    this.statusEl.hidden = !lines.length && this.status !== 'running';
    this.statusEl.classList.toggle('error', this.status === 'error');
    this.stopBtn.hidden = this.status !== 'running';
    this.undoBtn.hidden = !this.undo || this.status === 'running' || !!this.busy;
    this.replaceAllBtn.disabled = !matches || this.status !== 'done' || !!this.pending || !!this.busy;
    this.el.classList.toggle('busy', this.status === 'running');
  }

  renderResults() {
    const { h, t } = this.app;
    this.list.replaceChildren(...this.results.filter((f) => f.matches.length > f.dismissed.size).map((f) => this.fileNode(f)));
    const showEmpty = !this.app.folder;
    this.empty.hidden = !showEmpty;
    if (showEmpty) {
      this.empty.replaceChildren(h('button', { class: 'btn primary', 'data-act': 'search-open-folder', onclick: () => this.app.pickFolder() }, t('openFolder')));
    }
    this.renderStatus();
  }

  fileNode(f) {
    const { h, t, app } = this;
    const name = f.rel.split('/').pop();
    const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
    const n = f.matches.length - f.dismissed.size;
    const replacing = this.opts.showReplace;
    const act = (ic, tip, fn, a) =>
      h('button', { class: 'code-sact', tabindex: -1, 'data-tip': tip, 'aria-label': tip, 'data-act': a, onclick: (e) => (e.stopPropagation(), fn()) }, app.icon(ic, { size: 14 }));
    const head = h(
      'div',
      {
        class: 'code-srow-file code-sr',
        role: 'treeitem',
        tabindex: -1,
        'aria-expanded': String(f.open),
        'data-path': f.path,
        title: f.path,
        onclick: () => {
          f.open = !f.open;
          this.rerenderFile(f);
        },
      },
      h('span', { class: 'code-caret' }, app.icon(f.open ? 'caret-down' : 'caret-right', { size: 12 })),
      app.icon(app.ui.fileIcon({ name, ext: (/\.[^./]+$/.exec(name)?.[0] || '').toLowerCase() }), { size: 16, class: 'file-icon' }),
      h('span', { class: 'code-sname' }, name),
      dir ? h('span', { class: 'code-sdir' }, dir) : null,
      h('span', { class: 'code-grow' }),
      h('span', { class: 'code-scount', 'aria-label': t('resultCount', { count: n }) }, String(n)),
      h(
        'span',
        { class: 'code-sacts' },
        replacing ? act('arrow-u-down-left', t('replaceInFile'), () => this.replaceFile(f), 'replace-file') : null,
        act('x', t('dismissFile'), () => this.dismiss(f), 'dismiss-file'),
      ),
    );
    const node = h('div', { class: 'code-sfile', 'data-path': f.path }, head);
    if (f.open) {
      f.matches.forEach((m, i) => {
        if (f.dismissed.has(i)) return;
        node.append(this.matchNode(f, m, i, act));
      });
    }
    f.node = node;
    return node;
  }

  matchNode(f, m, i, act) {
    const { h, t } = this;  // (the app's)
    const text = m.text;
    let start = Math.max(0, Math.min(text.length, m.col - m.off));
    const end = Math.min(text.length, start + m.len);
    let lead = /^\s*/.exec(text)[0].length;
    if (lead > start) lead = start;
    // the side panel is narrow (and the row's buttons take more room on hover): keep the match in sight, with only a
    // word or two before it
    let from = lead;
    if (start - from > 12) {
      from = start - 8;
      const sp = text.lastIndexOf(' ', start - 2);
      if (sp >= from - 6 && sp < start - 1) from = sp + 1;
    }
    const pre = (m.off > 0 || from > lead ? '…' : '') + text.slice(from, start);
    const hit = text.slice(start, end) + (start + m.len > text.length ? '…' : '');
    const replacing = this.opts.showReplace;
    const rep = this.repOf(m);
    const preview = h(
      'span',
      { class: 'code-spreview' },
      pre,
      replacing ? h('del', { class: 'code-shit' }, hit) : h('mark', { class: 'code-shit' }, hit),
      replacing ? h('ins', { class: 'code-srep' }, rep) : null,
      text.slice(end),
    );
    return h(
      'div',
      {
        class: 'code-srow-match code-sr',
        role: 'treeitem',
        tabindex: -1,
        'data-line': m.line,
        'data-i': i,
        title: `${f.rel}:${m.line}:${m.col + 1}`,
        'aria-label': `${t('lineN', { line: m.line })} ${text.trim()}`,
        onclick: () => this.open(f, m),
      },
      h('span', { class: 'code-sline-no' }, String(m.line)),
      preview,
      h(
        'span',
        { class: 'code-sacts' },
        replacing ? act('arrow-u-down-left', t('replaceOne'), () => this.replaceMatch(f, i), 'replace-match') : null,
        act('x', t('dismiss'), () => this.dismiss(f, i), 'dismiss-match'),
      ),
    );
  }

  repOf(m) {
    return this.opts.regex ? (m.rep ?? '') : this.opts.replace;
  }

  rerenderFile(f) {
    const old = f.node;
    const fresh = this.fileNode(f);
    if (old?.parentNode) old.replaceWith(fresh);
    fresh.querySelector('.code-srow-file')?.focus();
  }

  dismiss(f, i) {
    if (i == null) for (let k = 0; k < f.matches.length; k++) f.dismissed.add(k);
    else f.dismissed.add(i);
    if (f.matches.length <= f.dismissed.size) f.node?.remove();
    else this.rerenderFile(f);
    this.renderStatus();
  }

  rows() {
    return [...this.list.querySelectorAll('.code-sr')];
  }

  listKey(e) {
    const rows = this.rows();
    if (!rows.length) return;
    const cur = document.activeElement?.closest?.('.code-sr');
    const i = rows.indexOf(cur);
    const fileOf = (row) => this.results.find((f) => f.node && f.node.contains(row));
    const go = (j) => rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (cur && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const f = fileOf(cur);
      if (!f) return;
      if (cur.classList.contains('code-srow-match')) {
        if (e.key === 'ArrowLeft') f.node.querySelector('.code-srow-file')?.focus();
      } else if (f.open !== (e.key === 'ArrowRight')) {
        f.open = e.key === 'ArrowRight';
        this.rerenderFile(f);
      }
    } else if (cur && e.key === 'Enter') {
      const f = fileOf(cur);
      if (!f) return;
      if (cur.classList.contains('code-srow-match')) {
        const k = Number(cur.dataset.i);
        if ((e.ctrlKey || e.metaKey) && this.opts.showReplace) this.replaceMatch(f, k);
        else this.open(f, f.matches[k]);
      } else if ((e.ctrlKey || e.metaKey) && this.opts.showReplace) this.replaceFile(f);
      else {
        f.open = !f.open;
        this.rerenderFile(f);
      }
    } else if (cur && e.key === 'Delete') {
      const f = fileOf(cur);
      if (!f) return;
      const next = rows[i + 1] || rows[i - 1];
      this.dismiss(f, cur.classList.contains('code-srow-match') ? Number(cur.dataset.i) : null);
      if (next?.isConnected) next.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  open(f, m) {
    return this.app.openAt(f.path, m.line, m.col, m.len);
  }

  // ---------------------------------------------------------------- replace
  replaceAll() {
    return this.apply({ kind: 'all' });
  }

  replaceFile(f) {
    return this.apply({ kind: 'file', path: f.path });
  }

  replaceMatch(f, i) {
    return this.apply({ kind: 'match', path: f.path, ordinal: i });
  }

  /** [{ f, only }] for a scope, on the current results. */
  targets(scope) {
    const live = (f) => f.matches.length > f.dismissed.size;
    if (scope.kind === 'all') return this.results.filter(live).map((f) => ({ f, only: null }));
    const f = this.results.find((x) => x.path === scope.path);
    if (!f || !live(f)) return [];
    if (scope.kind === 'file') return [{ f, only: null }];
    return f.matches[scope.ordinal] && !f.dismissed.has(scope.ordinal) ? [{ f, only: [scope.ordinal] }] : [];
  }

  async apply(scope) {
    const { app, t } = this;
    if (!app.folder || this.busy) return null;
    if (this.status === 'running' || this.pending) return null;
    if (this.summary?.limitHit) {
      await app.ui.alert(t('replaceLimited'), { parent: app.win });
      return null;
    }
    const o = this.opts;
    // a regular expression's replacements come from the search: it must have been made with this replacement
    if (o.regex && (this.searched?.replace !== o.replace || this.searched?.query !== o.query)) await this.run();
    const targets = this.targets(scope);
    if (!targets.length) return null;
    const total = targets.reduce((n, { f, only }) => n + (only ? only.length : f.matches.length - f.dismissed.size), 0);
    if (scope.kind === 'all') {
      const vars = { results: t('occurrences', { count: total }), files: t('fileCount', { count: targets.length }), text: o.replace };
      const ok = await app.ui.confirm(o.replace ? t('replaceConfirm', vars) : t('replaceConfirmEmpty', vars), {
        title: t('replaceAll'),
        okLabel: t('replaceAll'),
        parent: app.win,
      });
      if (!ok) return null;
    }
    this.busy = true;
    const undo = { id: null, buffers: [] };
    let done = 0;
    let doneFiles = 0;
    let skipped = 0;
    let keptDirty = 0;
    try {
      const disk = [];
      for (const target of targets) {
        if (!target.f.buffer) {
          disk.push(target);
          continue;
        }
        // an open document: in its buffer (Ctrl+Z there undoes it), saved when it had no unsaved change
        const { f, only } = target;
        const doc = app.docByPath(f.path);
        if (!doc || doc.version !== this.versions.get(f.path)) {
          skipped++;
          continue;
        }
        const state = app.docState(doc);
        const changes = [];
        f.matches.forEach((m, i) => {
          if (only ? !only.includes(i) : f.dismissed.has(i)) return;
          if (m.line > state.doc.lines) return;
          const from = state.doc.line(m.line).from + m.col;
          changes.push({ from, to: from + m.len, insert: this.repOf(m) });
        });
        if (!changes.length) continue;
        const cs = state.changes(changes);
        const inverse = cs.invert(state.doc);
        const wasClean = !doc.dirty;
        app.applyToDoc(doc, { changes: cs, userEvent: 'input.replace' });
        if (wasClean) await app.saveDoc(doc);
        else keptDirty++;
        undo.buffers.push({ doc, inverse, version: doc.version, wasClean });
        done += changes.length;
        doneFiles++;
      }
      if (disk.length) {
        // the others on disk: the backend applies the same matches, only to files unchanged since the search
        const files = disk.map(({ f, only }) => {
          const keep = only || f.matches.map((_, i) => i).filter((i) => !f.dismissed.has(i));
          return keep.length === f.matches.length ? { path: f.path, hash: f.hash } : { path: f.path, hash: f.hash, only: keep };
        });
        try {
          const res = await app.api.invoke('code:replace', app.folder, {
            query: this.searched.query,
            regex: this.searched.regex,
            matchCase: this.searched.matchCase,
            wholeWord: this.searched.wholeWord,
            replace: o.replace,
            files,
          });
          for (const c of res.changed) done += c.count;
          doneFiles += res.changed.length;
          skipped += res.skipped.length;
          undo.id = res.undoId;
          // a file opened in the editor since the search: show what is on disk now
          for (const c of res.changed) {
            const doc = app.docByPath(c.path);
            if (doc) await app.reloadDoc(doc);
          }
        } catch (err) {
          await app.ui.alert(t('replaceFailed', { error: err.message }), { parent: app.win });
        }
      }
      this.undo = undo.id || undo.buffers.length ? undo : null;
      const parts = [t('replaceDoneIn', { results: t('replaceDone', { count: done }), files: t('fileCount', { count: doneFiles }) })];
      if (skipped) parts.push(t('replaceSkipped', { count: skipped }));
      if (keptDirty) parts.push(t('replaceKeptDirty', { count: keptDirty }));
      this.message = parts.join(' ');
      this.lastReplace = { done, files: doneFiles, skipped, keptDirty };
      await app.afterReplace();
      // the results as they are now
      await this.run({ keepMessage: true });
    } finally {
      this.busy = false;
      this.renderStatus();
    }
    return this.lastReplace;
  }

  async undoReplace() {
    const { app, t } = this;
    const u = this.undo;
    if (!u || this.busy) return null;
    this.undo = null;
    this.busy = true;
    let restored = 0;
    let skipped = 0;
    try {
      for (const b of u.buffers) {
        if (!app.docs.has(b.doc) || b.doc.version !== b.version) {
          skipped++;
          continue;
        }
        app.applyToDoc(b.doc, { changes: b.inverse, userEvent: 'input.replace' });
        if (b.wasClean) await app.saveDoc(b.doc);
        restored++;
      }
      if (u.id) {
        try {
          const r = await app.api.invoke('code:replaceUndo', u.id);
          restored += r.restored.length;
          skipped += r.skipped.length;
          for (const p of r.restored) {
            const doc = app.docByPath(p);
            if (doc) await app.reloadDoc(doc);
          }
        } catch {
          skipped++;
        }
      }
      this.message = skipped ? `${t('undoDone')} ${t('undoSkipped', { count: skipped })}` : t('undoDone');
      await app.afterReplace();
      await this.run({ keepMessage: true });
    } finally {
      this.busy = false;
      this.renderStatus();
    }
    return { restored, skipped };
  }
}
