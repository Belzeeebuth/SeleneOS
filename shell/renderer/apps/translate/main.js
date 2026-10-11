// Translator: text translation (MyMemory or LibreTranslate), an English dictionary and an offline EN <-> FR glossary.
// Backend: main/ipc/translate.js (every request goes through the main process; mock answers in dev/tests).
// Test hooks: the window body element gets __translate.
const LANGS = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl'];
const TABS = ['translate', 'dictionary', 'settings'];
const LIMITS = { mymemory: 500, libre: 5000 };
const HISTORY_MAX = 50;

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, storage } = ctx;
    const uiLang = ctx.i18n?.lang === 'fr' ? 'fr' : 'en';
    const errMsg = (e) => String(e?.message || e || '').slice(0, 300);
    const safeGet = async (name, fallback) => {
      try {
        return (await storage?.get?.(name, fallback)) ?? fallback;
      } catch {
        return fallback;
      }
    };
    const save = (name, value) =>
      Promise.resolve()
        .then(() => storage?.set?.(name, value))
        .catch(() => {});

    // ------------------------------------------------------------ persisted state
    const rawSettings = await safeGet('settings', {});
    const settings = {
      provider: rawSettings?.provider === 'libre' ? 'libre' : 'mymemory',
      libreUrl: typeof rawSettings?.libreUrl === 'string' ? rawSettings.libreUrl.slice(0, 500) : '',
      libreKey: typeof rawSettings?.libreKey === 'string' ? rawSettings.libreKey.slice(0, 200) : '',
    };
    const rawPrefs = await safeGet('prefs', {});
    let source = rawPrefs?.source === 'auto' || LANGS.includes(rawPrefs?.source) ? rawPrefs.source : 'auto';
    let target = LANGS.includes(rawPrefs?.target) ? rawPrefs.target : uiLang === 'fr' ? 'en' : 'fr';
    let tab = TABS.includes(rawPrefs?.tab) ? rawPrefs.tab : 'translate';
    const rawHistory = await safeGet('history', []);
    let history = (Array.isArray(rawHistory) ? rawHistory : [])
      .filter((x) => x && typeof x.text === 'string' && typeof x.result === 'string' && LANGS.includes(x.target) && (x.source === 'auto' || LANGS.includes(x.source)))
      .slice(0, HISTORY_MAX)
      .map((x) => ({ id: String(x.id || Math.random().toString(36).slice(2)), source: x.source, detected: LANGS.includes(x.detected) ? x.detected : '', provider: ['mymemory', 'libre', 'glossary', 'mock'].includes(x.provider) ? x.provider : '', target: x.target, text: x.text.slice(0, 5000), result: x.result.slice(0, 20000), offline: !!x.offline, at: Number(x.at) || 0 }));
    const savePrefs = () => save('prefs', { source, target, tab });
    const limit = () => LIMITS[settings.provider];
    const langName = (l) => t(`lang.${l}`);

    // ------------------------------------------------------------ tabs
    const tabBtns = {};
    const panels = {};
    const tabIcons = { translate: 'translate', dictionary: 'book_open', settings: 'settings' };
    const tabList = h('div', { class: 'tabs tr-tabs', role: 'tablist', 'aria-label': t('tabs.label') });
    for (const id of TABS) {
      tabBtns[id] = h(
        'button',
        {
          class: 'tab',
          role: 'tab',
          id: `tr-tab-${id}`,
          'aria-controls': `tr-panel-${id}`,
          dataset: { tab: id },
          onclick: () => select(id, true),
          onkeydown: (e) => {
            const i = TABS.indexOf(id);
            let next = null;
            if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
            else if (e.key === 'ArrowLeft') next = TABS[(i + TABS.length - 1) % TABS.length];
            else if (e.key === 'Home') next = TABS[0];
            else if (e.key === 'End') next = TABS[TABS.length - 1];
            if (next) {
              e.preventDefault();
              select(next, true);
            }
          },
        },
        icon(tabIcons[id]),
        h('span', null, t(`tabs.${id}`)),
      );
      tabList.append(tabBtns[id]);
      panels[id] = h('section', { class: 'tr-panel', role: 'tabpanel', id: `tr-panel-${id}`, 'aria-labelledby': `tr-tab-${id}`, dataset: { panel: id } });
    }
    function select(id, focus) {
      tab = id;
      for (const k of TABS) {
        const on = k === id;
        tabBtns[k].classList.toggle('selected', on);
        tabBtns[k].setAttribute('aria-selected', on ? 'true' : 'false');
        tabBtns[k].tabIndex = on ? 0 : -1;
        panels[k].hidden = !on;
      }
      if (focus) tabBtns[id].focus();
      savePrefs();
    }

    // ------------------------------------------------------------ Translate
    const langOption = (l) => h('option', { value: l }, langName(l));
    const srcSel = h('select', { class: 'select tr-lang', id: 'tr-source', 'aria-label': t('tr.from'), onchange: () => setLangs(srcSel.value, target) }, langOption('auto'), LANGS.map(langOption));
    const dstSel = h('select', { class: 'select tr-lang', id: 'tr-target', 'aria-label': t('tr.to'), onchange: () => setLangs(source, dstSel.value) }, LANGS.map(langOption));
    const swapBtn = h('button', { class: 'btn subtle icon-btn tr-swap', dataset: { act: 'swap' }, 'aria-label': t('tr.swap'), 'data-tip': t('tr.swap'), onclick: () => swap() }, icon('arrow_swap'));
    const input = h('textarea', { class: 'tr-input', id: 'tr-input', 'aria-label': t('tr.input'), placeholder: t('tr.placeholder'), spellcheck: 'false', oninput: () => onInput(), onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        translate();
      }
    } });
    const counter = h('span', { class: 'caption tr-counter', 'aria-live': 'polite' });
    const detectedEl = h('span', { class: 'caption text-2 tr-detected' });
    const clearBtn = h('button', { class: 'btn subtle icon-btn', dataset: { act: 'clear' }, 'aria-label': t('tr.clear'), 'data-tip': t('tr.clear'), onclick: () => {
      input.value = '';
      onInput();
      setOutput('', null);
      input.focus();
    } }, icon('dismiss'));
    const output = h('div', { class: 'tr-output selectable', id: 'tr-output', role: 'status', 'aria-live': 'polite', 'aria-label': t('tr.output'), tabIndex: 0 });
    const viaEl = h('span', { class: 'caption text-2 tr-via' });
    const copyBtn = h('button', { class: 'btn subtle icon-btn', dataset: { act: 'copy' }, 'aria-label': t('tr.copy'), 'data-tip': t('tr.copy'), disabled: true, onclick: () => copy() }, icon('copy'));
    const goBtn = h('button', { class: 'btn primary tr-go', dataset: { act: 'translate' }, onclick: () => translate() }, icon('translate'), h('span', null, t('tr.translate')));
    const notice = h('div', { class: 'tr-notice' });
    const histList = h('ul', { class: 'tr-hist-list', 'aria-label': t('hist.title') });
    const histClear = h('button', { class: 'btn subtle', dataset: { act: 'clear-history' }, onclick: () => clearHistory() }, icon('delete'), h('span', null, t('hist.clear')));

    panels.translate.append(
      h('div', { class: 'tr-langbar' }, srcSel, swapBtn, dstSel),
      h(
        'div',
        { class: 'tr-panes' },
        h('div', { class: 'tr-pane tr-src' }, input, h('div', { class: 'tr-pane-foot' }, detectedEl, h('span', { class: 'grow' }), counter, clearBtn)),
        h('div', { class: 'tr-pane tr-dst' }, output, h('div', { class: 'tr-pane-foot' }, viaEl, h('span', { class: 'grow' }), copyBtn)),
      ),
      h('div', { class: 'tr-actions' }, goBtn, h('span', { class: 'caption text-2' }, t('tr.shortcut'))),
      notice,
      h('div', { class: 'tr-hist' }, h('div', { class: 'tr-hist-head' }, h('h2', { class: 'tr-h2' }, icon('history'), h('span', null, t('hist.title'))), h('span', { class: 'grow' }), histClear), histList),
    );

    let lastDetected = '';
    let trSeq = 0;
    let done = 0; // finished translations (tests wait on it)
    let busy = false;
    function setNotice(kind, ...lines) {
      const text = lines.filter(Boolean);
      if (!kind || !text.length) return notice.replaceChildren();
      notice.replaceChildren(
        h(
          'div',
          { class: `infobar ${kind} tr-info`, dataset: { kind }, role: kind === 'error' ? 'alert' : 'status' },
          icon(kind === 'error' ? 'error_circle' : kind === 'warning' ? 'cloud_off' : kind === 'success' ? 'checkmark_circle' : 'info'),
          h('div', { class: 'tr-info-text' }, text.map((x) => h('div', null, x))),
        ),
      );
    }
    function setLangs(s, d, { persist = true } = {}) {
      source = s === 'auto' || LANGS.includes(s) ? s : 'auto';
      target = LANGS.includes(d) ? d : 'fr';
      srcSel.value = source;
      dstSel.value = target;
      if (source !== 'auto') {
        lastDetected = '';
        detectedEl.textContent = '';
      }
      if (persist) savePrefs();
    }
    function onInput() {
      const n = input.value.length;
      const max = limit();
      counter.textContent = t('tr.counter', { n, max });
      counter.setAttribute('aria-label', t('tr.counterLabel', { n, max }));
      const over = n > max;
      counter.classList.toggle('over', over);
      input.setAttribute('aria-invalid', over ? 'true' : 'false');
      goBtn.disabled = busy || over || !input.value.trim();
      if (over) setNotice('error', t('tr.tooLong', { max }));
      else if (notice.querySelector('.tr-info')?.dataset.kind === 'error' && notice.textContent.includes(String(max))) setNotice(null);
    }
    function setOutput(text, res) {
      output.textContent = text || '';
      output.classList.toggle('empty-out', !text);
      if (!text) output.setAttribute('data-placeholder', t('tr.outputEmpty'));
      copyBtn.disabled = !text;
      viaEl.textContent = res && text ? t('tr.via', { provider: t(`provider.${res.provider}`) }) : '';
      if (res?.detected && source === 'auto') {
        lastDetected = res.detected;
        detectedEl.textContent = t('tr.detected', { lang: langName(res.detected) });
      } else if (!res) {
        detectedEl.textContent = '';
      }
    }
    async function translate() {
      const text = input.value;
      if (busy || !text.trim() || text.length > limit()) return;
      const seq = ++trSeq;
      busy = true;
      goBtn.disabled = true;
      win.body.classList.add('tr-busy');
      viaEl.textContent = t('tr.working');
      let res;
      try {
        res = await api.invoke('translate:text', { text, source, target, provider: settings.provider, libreUrl: settings.libreUrl, libreKey: settings.libreKey });
      } catch (e) {
        if (seq !== trSeq || win.closed) return;
        const code = e?.code;
        setOutput('', null);
        setNotice(
          'error',
          code === 'EOFFLINE' ? t('tr.offlinePair') : code === 'EQUOTA' ? t('tr.quota') : code === 'ETIMEDOUT' ? t('tr.timeout') : code === 'EINVAL' && settings.provider === 'libre' && /address/i.test(errMsg(e)) ? t('tr.badUrl') : code === 'ETOOLONG' ? t('tr.tooLong', { max: limit() }) : t('tr.failed', { msg: errMsg(e) }),
        );
        return;
      } finally {
        if (seq === trSeq) {
          done++;
          busy = false;
          win.body.classList.remove('tr-busy');
          onInput();
        }
      }
      if (seq !== trSeq || win.closed) return;
      setOutput(String(res?.text ?? ''), res);
      if (res?.offline) {
        const n = Array.isArray(res.unknown) ? res.unknown.length : 0;
        setNotice('warning', t('tr.offline'), n ? t(n === 1 ? 'tr.unknown_one' : 'tr.unknown_other', { count: n }) : '');
      } else setNotice(null);
      addHistory({ source, detected: res?.detected || '', provider: String(res?.provider || ''), target, text, result: String(res?.text ?? ''), offline: !!res?.offline });
    }
    function swap() {
      const from = source === 'auto' ? lastDetected || (target === 'en' ? 'fr' : 'en') : source;
      if (from === target) return;
      const out = output.textContent;
      setLangs(target, from);
      if (out) {
        input.value = out;
        setOutput('', null);
      }
      onInput();
      swapBtn.focus();
    }
    async function copy() {
      const text = output.textContent;
      if (!text) return;
      try {
        await api.invoke('clipboard:writeText', text);
        setNotice('success', t('tr.copied'));
      } catch (e) {
        setNotice('error', errMsg(e));
      }
    }

    // ------------------------------------------------------------ history
    function addHistory(entry) {
      const top = history[0];
      if (top && top.text === entry.text && top.target === entry.target && top.source === entry.source) history.shift();
      history.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), ...entry });
      history = history.slice(0, HISTORY_MAX);
      save('history', history);
      renderHistory();
    }
    function renderHistory() {
      histClear.disabled = !history.length;
      if (!history.length) {
        histList.replaceChildren(h('li', { class: 'tr-hist-empty caption text-2' }, t('hist.empty')));
        return;
      }
      histList.replaceChildren(
        ...history.map((x) => {
          const from = x.source === 'auto' ? x.detected || 'auto' : x.source;
          const label = t('hist.item', { from: langName(from), to: langName(x.target), text: x.text });
          return h(
            'li',
            { class: 'tr-hist-item' },
            h(
              'button',
              { class: 'tr-hist-btn', dataset: { id: x.id }, 'aria-label': label, onclick: () => restore(x) },
              h('span', { class: 'tr-hist-langs caption' }, `${from === 'auto' ? '?' : from.toUpperCase()} → ${x.target.toUpperCase()}`, x.offline ? h('span', { class: 'tr-hist-off' }, ` · ${t('hist.offline')}`) : ''),
              h('span', { class: 'tr-hist-text' }, x.text),
              h('span', { class: 'tr-hist-result text-2' }, x.result),
            ),
          );
        }),
      );
    }
    function restore(x) {
      setLangs(x.source, x.target);
      input.value = x.text;
      onInput();
      setOutput(x.result, { provider: x.provider || (x.offline ? 'glossary' : settings.provider), detected: x.detected });
      setNotice(null);
      input.focus();
    }
    async function clearHistory() {
      if (!history.length) return;
      const ok = await ui.confirm(t('hist.clearBody', { count: history.length }), { title: t('hist.clearTitle'), okLabel: t('hist.clearOk'), danger: true, parent: win });
      if (!ok || win.closed) return;
      history = [];
      save('history', history);
      renderHistory();
      input.focus();
    }

    // ------------------------------------------------------------ Dictionary
    const wordInput = h('input', { class: 'input grow', id: 'tr-word', placeholder: t('dict.placeholder'), spellcheck: 'false', autocomplete: 'off', maxLength: 60 });
    const lookupBtn = h('button', { class: 'btn primary', type: 'submit', dataset: { act: 'lookup' } }, icon('search'), h('span', null, t('dict.lookup')));
    const dictStatus = h('div', { class: 'tr-dict-status', role: 'status', 'aria-live': 'polite' });
    const dictOut = h('div', { class: 'tr-dict-out selectable' });
    panels.dictionary.append(
      h('h2', { class: 'tr-h2' }, t('dict.title')),
      h('form', { class: 'tr-dict-form', onsubmit: (e) => (e.preventDefault(), lookup()) }, h('label', { class: 'tr-label', for: 'tr-word' }, t('dict.word')), h('div', { class: 'tr-row' }, wordInput, lookupBtn)),
      dictStatus,
      dictOut,
      h('div', { class: 'caption text-2 tr-dict-hint' }, t('dict.hint')),
    );
    let dictSeq = 0;
    function dictInfo(kind, text) {
      dictStatus.replaceChildren(text ? h('div', { class: `infobar ${kind} tr-info`, dataset: { kind }, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'error_circle' : kind === 'warning' ? 'cloud_off' : 'info'), h('div', { class: 'tr-info-text' }, text)) : '');
    }
    async function lookup() {
      const word = wordInput.value.trim();
      const seq = ++dictSeq;
      dictOut.replaceChildren();
      if (!word || !/^[\p{L}][\p{L}' -]*$/u.test(word)) {
        dictInfo('error', t('dict.invalid'));
        wordInput.setAttribute('aria-invalid', 'true');
        wordInput.focus();
        return;
      }
      wordInput.removeAttribute('aria-invalid');
      dictStatus.replaceChildren(h('div', { class: 'caption text-2' }, t('dict.working')));
      lookupBtn.disabled = true;
      try {
        const res = await api.invoke('translate:define', word);
        if (seq !== dictSeq || win.closed) return;
        renderDefinition(res);
      } catch (e) {
        if (seq !== dictSeq || win.closed) return;
        const code = e?.code;
        dictInfo('error', code === 'ENOTFOUND' ? t('dict.notFound', { word }) : code === 'EINVAL' ? t('dict.invalid') : code === 'EOFFLINE' || code === 'ETIMEDOUT' ? t('dict.offlineNone', { word }) : t('dict.failed', { msg: errMsg(e) }));
      } finally {
        if (seq === dictSeq) lookupBtn.disabled = false;
      }
    }
    function renderDefinition(res) {
      const word = String(res?.word || '');
      const head = h('div', { class: 'tr-dict-head' }, h('div', { class: 'tr-dict-word' }, word), res?.phonetic ? h('div', { class: 'tr-dict-phon text-2' }, String(res.phonetic)) : '');
      const fr = res?.glossary ? h('div', { class: 'tr-dict-fr' }, icon('translate'), h('span', null, t('dict.french', { word: String(res.glossary) }))) : '';
      if (res?.offline) {
        dictInfo('warning', t('dict.offline'));
        dictOut.replaceChildren(head, fr);
        return;
      }
      dictStatus.replaceChildren();
      const meanings = (Array.isArray(res?.meanings) ? res.meanings : []).map((m) => {
        const pos = String(m?.partOfSpeech || 'other');
        const posLabel = t(`dict.pos.${pos}`) !== `dict.pos.${pos}` ? t(`dict.pos.${pos}`) : pos;
        return h(
          'section',
          { class: 'tr-meaning card' },
          h('div', { class: 'tr-pos' }, posLabel),
          h(
            'ol',
            { class: 'tr-defs' },
            (Array.isArray(m?.definitions) ? m.definitions : []).map((d) => h('li', null, h('div', null, String(d?.definition || '')), d?.example ? h('div', { class: 'tr-example text-2' }, `“${d.example}”`) : '')),
          ),
          Array.isArray(m?.synonyms) && m.synonyms.length ? h('div', { class: 'caption text-2 tr-syn' }, t('dict.synonyms', { list: m.synonyms.join(', ') })) : '',
        );
      });
      dictOut.replaceChildren(head, fr, ...meanings);
    }

    // ------------------------------------------------------------ Settings
    const radio = (value) =>
      h(
        'label',
        { class: 'tr-radio card-row' },
        h('input', { type: 'radio', name: `tr-provider-${win.id || 'w'}`, value, checked: settings.provider === value, onchange: () => setProvider(value) }),
        h('div', { class: 'grow' }, h('div', { class: 'tr-radio-title' }, t(`set.${value}`)), h('div', { class: 'caption text-2' }, t(`set.${value}Hint`))),
      );
    const urlInput = h('input', { class: 'input', id: 'tr-libre-url', type: 'url', placeholder: t('set.urlPlaceholder'), value: settings.libreUrl, spellcheck: 'false', autocomplete: 'off', maxLength: 500, onchange: () => saveLibre() });
    const keyInput = h('input', { class: 'input', id: 'tr-libre-key', type: 'password', value: settings.libreKey, autocomplete: 'off', maxLength: 200, onchange: () => saveLibre() });
    const urlError = h('div', { class: 'caption tr-url-error', role: 'alert' });
    const setStatus = h('div', { class: 'caption text-2 tr-set-status', role: 'status', 'aria-live': 'polite' });
    const libreBox = h('div', { class: 'tr-libre' }, h('label', { class: 'tr-label', for: 'tr-libre-url' }, t('set.url')), urlInput, urlError, h('label', { class: 'tr-label', for: 'tr-libre-key' }, t('set.key')), keyInput);
    panels.settings.append(
      h('h2', { class: 'tr-h2' }, t('set.title')),
      h('div', { class: 'tr-radios', role: 'radiogroup', 'aria-label': t('set.title') }, radio('mymemory'), radio('libre')),
      libreBox,
      setStatus,
      h('div', { class: 'caption text-2 tr-dict-hint' }, icon('info'), h('span', null, t('set.dictNote'))),
    );
    const validUrl = (u) => {
      try {
        const x = new URL(u);
        return /^https?:$/.test(x.protocol) && !x.username && !x.password;
      } catch {
        return false;
      }
    };
    function setProvider(p) {
      settings.provider = p === 'libre' ? 'libre' : 'mymemory';
      libreBox.hidden = settings.provider !== 'libre';
      persistSettings();
      onInput();
    }
    function saveLibre() {
      const u = urlInput.value.trim();
      if (u && !validUrl(u)) {
        urlError.textContent = t('set.urlInvalid');
        urlInput.setAttribute('aria-invalid', 'true');
        return;
      }
      urlError.textContent = '';
      urlInput.removeAttribute('aria-invalid');
      settings.libreUrl = u;
      settings.libreKey = keyInput.value.trim();
      persistSettings();
    }
    function persistSettings() {
      save('settings', { ...settings });
      setStatus.textContent = t('set.saved');
    }

    // ------------------------------------------------------------ layout
    const root = h('div', { class: 'tr-root' }, h('div', { class: 'tr-top' }, tabList), h('div', { class: 'tr-panels' }, TABS.map((id) => panels[id])));
    win.body.append(root);
    setLangs(source, target, { persist: false });
    libreBox.hidden = settings.provider !== 'libre';
    setOutput('', null);
    onInput();
    renderHistory();
    select(tab, false);
    win.body.__translate = {
      select,
      translate,
      lookup,
      swap,
      setLangs,
      setProvider,
      get state() {
        return { tab, source, target, provider: settings.provider, libreUrl: settings.libreUrl, history: history.map((x) => ({ ...x })), busy, done, lastDetected, limit: limit() };
      },
    };
    if (tab === 'translate') setTimeout(() => !win.closed && input.focus(), 0);
    return {
      onRelaunch(args) {
        if (typeof args?.text === 'string') {
          select('translate', false);
          input.value = args.text.slice(0, 5000);
          onInput();
          input.focus();
        }
        win.focus();
      },
    };
  },
};
