// « Ajouter un abonnement »: a feed or website address (autodiscovery: <link rel="alternate">, then feed-like links,
// then the usual /feed, /rss.xml… addresses) or a podcast search in the Apple Podcasts directory (feeds:search).
import { parseFeed, looksLikeHtml, discover, guessFeedLinks, commonFeedPaths } from './parse.js';
import { normaliseUrl, hostOf } from './util.js';

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** feeds:fetch, with an HTTP error answer turned into an Error (code EHTTP, status, retryAfter). */
export async function getDoc(api, url, opts) {
  const res = await api.invoke('feeds:fetch', url, opts);
  if (res?.error) {
    const e = fail(`The server answered ${res.status}`, res.error);
    e.status = res.status;
    e.retryAfter = res.retryAfter;
    throw e;
  }
  return res;
}

/** Fetch and parse a feed address: { url, res, parsed }. Rejects ENOTFEED when it is a web page. */
export async function fetchFeed(api, url) {
  const res = await getDoc(api, url);
  if (res.status !== 200) throw fail('Unexpected answer', 'EFAIL');
  if (looksLikeHtml(res.text, res.contentType)) throw fail('This is a web page', 'ENOTFEED');
  return { url, res, parsed: parseFeed(res.text, res.url) };
}

/**
 * What the person typed -> { url, res, parsed } (a feed) or { choices: [{ url, title }] } (a site with several feeds).
 * Rejects EINVAL (not an address), ENOFEED (a page without a feed) or a network / parse error code.
 */
export async function findFeed(api, input) {
  const url = normaliseUrl(input);
  if (!url) throw fail('Invalid address', 'EINVAL');
  const res = await getDoc(api, url);
  if (res.status !== 200) throw fail('Unexpected answer', 'EFAIL');
  if (!looksLikeHtml(res.text, res.contentType)) {
    try {
      return { url, res, parsed: parseFeed(res.text, res.url) };
    } catch (e) {
      if (e.code !== 'ENOTFEED') throw e;
    }
  }
  let cands = discover(res.text, res.url);
  if (!cands.length) cands = guessFeedLinks(res.text, res.url).map((u) => ({ url: u, title: '' }));
  if (cands.length > 1) return { choices: cands.slice(0, 12) };
  if (cands.length === 1) return fetchFeed(api, cands[0].url);
  for (const u of commonFeedPaths(res.url)) {
    try {
      return await fetchFeed(api, u);
    } catch {}
  }
  throw fail('No feed at this address', 'ENOFEED');
}

export function openAddDialog(app, { tab = 'address', url = '' } = {}) {
  const { h, t, icon, ui, api } = app;
  let current = tab === 'search' ? 'search' : 'address';
  let busy = false;
  let closeDialog = null;

  // ---------------------------------------------------------------- address
  const urlInput = h('input', {
    class: 'input fd-add-url',
    type: 'url',
    id: 'fd-add-url',
    value: url,
    placeholder: t('add.addressPlaceholder'),
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'fd-add-hint',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAddress();
      }
    },
  });
  const goBtn = h('button', { class: 'btn primary fd-add-go', name: 'subscribe', onclick: () => submitAddress() }, t('add.subscribe'));
  const status = h('div', { class: 'fd-add-status', role: 'status' });
  const choicesEl = h('div', { class: 'fd-add-choices', hidden: true });
  const addressPanel = h(
    'div',
    { class: 'fd-add-panel', role: 'tabpanel', id: 'fd-add-panel-address', 'aria-labelledby': 'fd-add-tab-address' },
    h('label', { class: 'fd-add-label', for: 'fd-add-url' }, t('add.addressLabel')),
    h('div', { class: 'fd-add-row' }, urlInput, goBtn),
    h('div', { class: 'fd-add-hint', id: 'fd-add-hint' }, t('add.addressHint')),
    status,
    choicesEl,
  );

  const setStatus = (el, kind, text) => {
    ui.clear(el);
    el.className = `fd-add-status ${kind || ''}`;
    el.removeAttribute('role');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (!text) return;
    if (kind === 'busy') el.append(h('span', { class: 'spinner small' }), h('span', null, text));
    else if (kind === 'error') el.append(icon('warning-circle', { size: 16 }), h('span', null, text));
    else el.append(icon('check-circle', { size: 16 }), h('span', null, text));
  };
  const setBusy = (b) => {
    busy = b;
    goBtn.disabled = b;
    urlInput.readOnly = b;
  };

  async function done(found) {
    const r = await app.subscribe(found.url, found.res, found.parsed);
    if (r.existing) {
      setStatus(status, 'ok', t('add.already', { name: app.feedTitle(r.feed) }));
      return;
    }
    closeDialog?.(true);
  }

  async function submitAddress() {
    if (busy) return;
    const value = urlInput.value.trim();
    choicesEl.hidden = true;
    ui.clear(choicesEl);
    if (!normaliseUrl(value)) {
      setStatus(status, 'error', app.errorLine('EINVAL'));
      urlInput.focus();
      return;
    }
    const already = app.store.feedByUrl(normaliseUrl(value));
    if (already) {
      setStatus(status, 'ok', t('add.already', { name: app.feedTitle(already) }));
      return;
    }
    setBusy(true);
    setStatus(status, 'busy', t('add.checking'));
    try {
      const found = await findFeed(api, value);
      if (found.choices) {
        setStatus(status, '', '');
        showChoices(found.choices);
      } else {
        setStatus(status, '', '');
        await done(found);
      }
    } catch (e) {
      setStatus(status, 'error', app.errorLine(e.code || 'EFAIL', e));
      urlInput.focus();
    } finally {
      setBusy(false);
    }
  }

  function showChoices(list) {
    ui.clear(choicesEl);
    choicesEl.hidden = false;
    const name = `fd-choice-${Date.now()}`;
    const radios = list.map((c, i) =>
      h(
        'label',
        { class: 'fd-choice' },
        h('input', { type: 'radio', name, value: c.url, checked: i === 0 }),
        h('span', { class: 'fd-choice-text' }, h('span', { class: 'fd-choice-title' }, c.title || hostOf(c.url)), h('span', { class: 'fd-choice-url' }, c.url)),
      ),
    );
    const btn = h(
      'button',
      {
        class: 'btn primary fd-choice-go',
        name: 'subscribe-choice',
        onclick: async () => {
          const pick = choicesEl.querySelector('input[type="radio"]:checked')?.value;
          if (!pick || busy) return;
          if (app.store.feedByUrl(pick)) {
            setStatus(status, 'ok', t('add.already', { name: app.feedTitle(app.store.feedByUrl(pick)) }));
            return;
          }
          setBusy(true);
          btn.disabled = true;
          setStatus(status, 'busy', t('add.checking'));
          try {
            const found = await fetchFeed(api, pick);
            setStatus(status, '', '');
            await done(found);
          } catch (e) {
            setStatus(status, 'error', app.errorLine(e.code || 'EFAIL', e));
          } finally {
            setBusy(false);
            btn.disabled = false;
          }
        },
      },
      t('add.subscribe'),
    );
    choicesEl.append(h('div', { class: 'fd-add-label', id: `${name}-label` }, t('add.choose')), h('div', { class: 'fd-choice-list', role: 'radiogroup', 'aria-labelledby': `${name}-label` }, radios), h('div', { class: 'fd-add-row end' }, btn));
    choicesEl.querySelector('input[type="radio"]')?.focus();
  }

  // ---------------------------------------------------------------- search
  const searchInput = h('input', {
    class: 'input fd-search-input',
    type: 'search',
    id: 'fd-search-input',
    placeholder: t('add.searchPlaceholder'),
    autocomplete: 'off',
    spellcheck: 'false',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch();
      }
    },
  });
  const searchBtn = h('button', { class: 'btn primary fd-search-go', name: 'search', onclick: () => runSearch() }, icon('magnifying-glass'), t('add.searchButton'));
  const searchStatus = h('div', { class: 'fd-add-status', role: 'status' });
  const results = h('ul', { class: 'fd-results', 'aria-label': t('add.results') });
  const searchPanel = h(
    'div',
    { class: 'fd-add-panel', role: 'tabpanel', id: 'fd-add-panel-search', 'aria-labelledby': 'fd-add-tab-search' },
    h('label', { class: 'fd-add-label', for: 'fd-search-input' }, t('add.searchLabel')),
    h('div', { class: 'fd-add-row' }, searchInput, searchBtn),
    searchStatus,
    results,
    h('div', { class: 'fd-add-hint' }, t('add.searchSource')),
  );
  let searchSeq = 0;

  async function runSearch() {
    const q = searchInput.value.trim();
    if (q.length < 2) {
      searchInput.focus();
      return;
    }
    const seq = ++searchSeq;
    searchBtn.disabled = true;
    setStatus(searchStatus, 'busy', t('add.searching'));
    ui.clear(results);
    try {
      const list = await api.invoke('feeds:search', q, { country: app.ctx.lang === 'fr' ? 'fr' : 'us', limit: 25 });
      if (seq !== searchSeq) return;
      setStatus(searchStatus, '', list.length ? t('add.resultCount', { count: list.length }) : '');
      if (!list.length) setStatus(searchStatus, 'error', t('add.noResults'));
      for (const r of list) results.appendChild(resultRow(r));
    } catch (e) {
      if (seq !== searchSeq) return;
      setStatus(searchStatus, 'error', app.errorLine(e.code || 'EFAIL', e));
    } finally {
      if (seq === searchSeq) searchBtn.disabled = false;
    }
  }

  function resultRow(r) {
    const letter = (r.title.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
    const art = h('span', { class: 'fd-art fd-art-md fd-letter', 'aria-hidden': 'true' }, letter);
    if (r.artwork) {
      app.cachedImage(r.artwork).then((p) => {
        if (!p || !art.isConnected) return;
        const img = h('img', { class: 'fd-art fd-art-md', alt: '', src: api.mediaUrl(p) });
        img.addEventListener('load', () => art.replaceWith(img));
      });
    }
    const subscribed = () => !!app.store.feedByUrl(r.feedUrl);
    const btn = h('button', { class: 'btn fd-result-sub', name: 'subscribe-result', 'aria-label': t('add.subscribeTo', { name: r.title }) }, t('add.subscribe'));
    const msg = h('div', { class: 'fd-result-msg', role: 'status' });
    const paint = () => {
      const on = subscribed();
      btn.textContent = on ? t('add.subscribed') : t('add.subscribe');
      btn.disabled = on;
      btn.classList.toggle('primary', !on);
    };
    paint();
    btn.addEventListener('click', async () => {
      if (subscribed() || btn.disabled) return;
      btn.disabled = true;
      ui.clear(msg);
      msg.append(h('span', { class: 'spinner small' }));
      try {
        const found = await fetchFeed(api, r.feedUrl);
        await app.subscribe(r.feedUrl, found.res, found.parsed, { select: true });
        ui.clear(msg);
      } catch (e) {
        ui.clear(msg);
        msg.append(icon('warning-circle', { size: 14 }), h('span', null, app.errorLine(e.code || 'EFAIL', e)));
      }
      paint();
    });
    const meta = [r.author, r.genre, r.episodes ? t('add.episodes', { count: r.episodes }) : null].filter(Boolean).join(' · ');
    return h('li', { class: 'fd-result', dataset: { feed: r.feedUrl } }, art, h('div', { class: 'fd-result-text' }, h('div', { class: 'fd-result-title' }, r.title), h('div', { class: 'fd-result-meta' }, meta), msg), btn);
  }

  // ---------------------------------------------------------------- tabs
  const tabBtn = (id, label) =>
    h(
      'button',
      {
        class: 'fd-add-tab',
        role: 'tab',
        id: `fd-add-tab-${id}`,
        'aria-controls': `fd-add-panel-${id}`,
        dataset: { tab: id },
        onclick: () => select(id, true),
        onkeydown: (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            select(current === 'address' ? 'search' : 'address', true, true);
          }
        },
      },
      label,
    );
  const tabs = h('div', { class: 'fd-add-tabs', role: 'tablist', 'aria-label': t('add.title') }, tabBtn('address', t('add.tabAddress')), tabBtn('search', t('add.tabSearch')));
  function select(id, focusInput = false, focusTab = false) {
    current = id;
    for (const b of tabs.querySelectorAll('.fd-add-tab')) {
      const on = b.dataset.tab === id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focusTab) b.focus();
    }
    addressPanel.hidden = id !== 'address';
    searchPanel.hidden = id !== 'search';
    if (focusInput && !focusTab) (id === 'address' ? urlInput : searchInput).focus();
  }
  select(current);

  const body = h('div', { class: 'fd-addbox' }, tabs, addressPanel, searchPanel);
  app.addDialogEl = body;
  return ui
    .dialog({
      title: t('add.title'),
      body,
      parent: app.win,
      className: 'fd-add-dialog',
      width: 560,
      buttons: [{ label: t('common.close'), value: null }],
      onOpen: (dlg, close) => {
        closeDialog = close;
        setTimeout(() => (current === 'address' ? urlInput : searchInput).focus(), 40);
        if (url) setTimeout(() => submitAddress(), 60);
      },
    })
    .finally(() => {
      app.addDialogEl = null;
    });
}
