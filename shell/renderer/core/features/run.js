// Run dialog (Super+R, Win+X > Run): a small window at the bottom-left of the screen.
//   Accepts an app id / name / classic alias ("calc", "notepad", "explorer", "cmd", "control"…, fuzzy
//   matched against the registry), optionally followed by a file or folder ("notepad ~/a.txt"),
//   a folder path (opens Files), a file path (opens with its default app), a URL or www.* address
//   (opens the browser) or a settings page ("ms-settings:display").
//   History (most recent first, max 26) persists in storage 'shell' / 'run-history'.
// Shell bus: shell.on('run:open') opens it (focuses the existing one).
import { api, env } from '../api.js';
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { wm } from '../wm.js';
import { registry } from '../registry.js';
import { shell } from '../services.js';

i18n.extend({
  en: {
    run: {
      title: 'Run',
      intro: 'Type the name of a program, folder, document, or Internet resource, and Aurora will open it for you.',
      open: 'Open:',
      browse: 'Browse…',
      notFound: "Aurora can't find '{cmd}'. Make sure you typed the name correctly, and then try again.",
      noBrowser: 'No web browser is installed.',
      history: 'Recent',
      apps: 'Apps',
      showHistory: 'Show history',
    },
  },
  fr: {
    run: {
      title: 'Exécuter',
      intro: "Entrez le nom d'un programme, dossier, document ou ressource Internet, et Aurora l'ouvrira pour vous.",
      open: 'Ouvrir :',
      browse: 'Parcourir…',
      notFound: 'Aurora ne trouve pas « {cmd} ». Vérifiez que le nom est correct, puis réessayez.',
      noBrowser: "Aucun navigateur web n'est installé.",
      history: 'Récents',
      apps: 'Applications',
      showHistory: "Afficher l'historique",
    },
  },
});

const RUN_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ec8ff"/><stop offset="1" stop-color="#0063b8"/></linearGradient></defs><rect x="2.5" y="4.5" width="27" height="23" rx="4" fill="url(#g)"/><rect x="5" y="10" width="22" height="15" rx="2" fill="#fff"/><path d="M10.5 17.5h9.5m-3.5-3.5 3.5 3.5-3.5 3.5" stroke="#0067c0" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="7.3" r="1" fill="#fff"/><circle cx="10" cy="7.3" r="1" fill="#fff" opacity=".7"/></svg>`,
  );

// Classic Windows / Linux command names -> Aurora app ids.
const ALIASES = {
  calc: 'calculator', 'calc.exe': 'calculator', calculator: 'calculator', 'gnome-calculator': 'calculator',
  notepad: 'notepad', 'notepad.exe': 'notepad', gedit: 'notepad', write: 'notepad', wordpad: 'notepad',
  explorer: 'files', 'explorer.exe': 'files', nautilus: 'files', files: 'files',
  cmd: 'terminal', 'cmd.exe': 'terminal', powershell: 'terminal', pwsh: 'terminal', wt: 'terminal', bash: 'terminal', sh: 'terminal', terminal: 'terminal', 'gnome-terminal': 'terminal',
  control: 'settings', 'control.exe': 'settings', 'ms-settings:': 'settings', settings: 'settings', 'gnome-control-center': 'settings',
  taskmgr: 'taskmgr', 'taskmgr.exe': 'taskmgr', top: 'taskmgr', htop: 'taskmgr',
  mspaint: 'paint', 'mspaint.exe': 'paint', paint: 'paint',
  winver: 'winver', msedge: 'browser', chrome: 'browser', firefox: 'browser', iexplore: 'browser', browser: 'browser',
  outlook: 'mail', thunderbird: 'mail', mail: 'mail',
  snippingtool: 'snipping', 'snippingtool.exe': 'snipping', wmplayer: 'media', vlc: 'media', totem: 'media',
};

const WEB_URL = /^(https?|ftp):\/\/[^\s]+$/i;

export function parseCommand(input) {
  const s = String(input || '').trim();
  const toks = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) toks.push(m[1] ?? m[2] ?? m[3]);
  return toks;
}

function expandHome(p) {
  if (p === '~') return env.home;
  if (p.startsWith('~/')) return `${env.home}${p.slice(1)}`;
  if (p.startsWith('%USERPROFILE%')) return env.home + p.slice('%USERPROFILE%'.length).replace(/\\/g, '/');
  return p;
}

// How well a typed name matches an app: exact id / name (100), prefix, substring, subsequence; matches on
// the app's keywords count a little less than matches on its id or name (so "no" ranks Notepad first).
export function scoreApp(q, a) {
  const s = String(q || '').trim().toLowerCase();
  if (!s || !a) return 0;
  const names = [a.id, i18n.name(a.name), a.name?.en, a.name?.fr].filter(Boolean).map((x) => String(x).toLowerCase());
  const keywords = [...(a.keywords?.[i18n.lang] || []), ...(a.keywords?.en || [])].filter(Boolean).map((x) => String(x).toLowerCase());
  let score = 0;
  for (const [list, penalty] of [[names, 0], [keywords, 10]]) {
    for (const n of list) {
      let v = 0;
      if (n === s) v = 100;
      else if (n.startsWith(s) && s.length >= 2) v = 80 - Math.min(20, n.length - s.length);
      else if (n.includes(s) && s.length >= 3) v = 55;
      else if (s.length >= 3 && isSubsequence(s, n)) v = 35;
      if (v) score = Math.max(score, v - penalty);
    }
  }
  return score;
}

// Best registry match for a typed name (classic aliases first, e.g. "calc", "explorer", "cmd").
export function matchApp(q, apps = registry.list({ includeHidden: true })) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return null;
  const alias = ALIASES[s];
  if (alias && apps.some((a) => a.id === alias)) return alias;
  let best = null;
  let bestScore = 0;
  for (const a of apps) {
    const score = scoreApp(s, a);
    if (score > bestScore) {
      bestScore = score;
      best = a.id;
    }
  }
  return bestScore >= 25 ? best : null;
}

function isSubsequence(a, b) {
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length;
}

// Turn a command line into an action: { kind: 'app'|'url'|'path'|'settings', ... } or null.
export async function resolveCommand(input, { stat = (p) => api.invoke('fs:stat', p) } = {}) {
  const s = String(input || '').trim();
  if (!s) return null;
  // Only web addresses go to the browser. file:// is opened like a path; any other scheme
  // (javascript:, data:, app:, media:…) is refused rather than handed to a web page.
  const fileUrl = /^file:\/\/(\/[^?#]*)$/i.exec(s);
  if (fileUrl) {
    let p = fileUrl[1];
    try {
      p = decodeURIComponent(p);
    } catch {}
    const st = await stat(p).catch(() => null);
    return st ? { kind: 'path', path: p, dir: !!st.dir } : null;
  }
  if (WEB_URL.test(s) || /^mailto:[^\s]+$/i.test(s) || /^about:(blank|home|newtab)$/i.test(s)) return { kind: 'url', url: s };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(ms-settings|aurora-settings|settings):/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return null;
  if (/^www\.[^\s]+\.[a-z]{2,}/i.test(s)) return { kind: 'url', url: `https://${s}` };
  const ms = /^(ms-settings|aurora-settings|settings):([\w-]*)$/i.exec(s);
  if (ms) return { kind: 'app', appId: 'settings', args: ms[2] ? { page: ms[2] } : {} };
  const toks = parseCommand(s);
  const looksLikePath = (p) => /^(\/|~|\.\.?\/|%USERPROFILE%)/.test(p);
  if (looksLikePath(s) || (toks.length === 1 && looksLikePath(toks[0]))) {
    const p = expandHome(toks.length === 1 ? toks[0] : s);
    const st = await stat(p).catch(() => null);
    if (st) return { kind: 'path', path: p, dir: !!st.dir };
    return null;
  }
  const appId = matchApp(toks[0]);
  if (!appId) return null;
  const rest = toks.slice(1).join(' ');
  if (!rest) return { kind: 'app', appId, args: {} };
  const p = expandHome(rest);
  if (WEB_URL.test(rest)) return { kind: 'app', appId, args: { url: rest } };
  const st = await stat(p).catch(() => null);
  if (st?.dir) return { kind: 'app', appId, args: { path: p, cwd: p } };
  if (st) return { kind: 'app', appId, args: { file: p } };
  return { kind: 'app', appId, args: { arg: rest } };
}

let win = null;
let input = null;
let drop = null;
let history = [];
let activeIdx = -1;

async function loadHistory() {
  try {
    const v = await api.invoke('storage:get', 'shell', 'run-history', []);
    history = Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 26) : [];
  } catch {
    history = [];
  }
}
function saveHistory(cmd) {
  history = [cmd, ...history.filter((x) => x !== cmd)].slice(0, 26);
  api.invoke('storage:set', 'shell', 'run-history', history).catch(() => {});
}

function suggestions(all) {
  const q = input.value.trim().toLowerCase();
  const hist = history.filter((x) => all || !q || x.toLowerCase().startsWith(q)).slice(0, 8);
  const apps =
    !all && q.length >= 2
      ? registry
          .list()
          .map((a) => [a, ALIASES[q] === a.id ? 200 : scoreApp(q, a)])
          .filter(([a, sc]) => sc >= 25 && !hist.includes(a.id))
          .sort((x, y) => y[1] - x[1])
          .slice(0, 5)
          .map(([a]) => a)
      : [];
  return { hist, apps };
}

function closeDrop() {
  drop?.remove();
  drop = null;
  activeIdx = -1;
}

function openDrop(all = false) {
  closeDrop();
  if (!win || !input) return;
  const { hist, apps } = suggestions(all);
  if (!hist.length && !apps.length) return;
  const r = input.closest('.run-combo').getBoundingClientRect();
  const rows = [];
  const row = (label, value, ic) => {
    const el = h(
      'div',
      {
        class: 'run-opt',
        role: 'option',
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => {
          input.value = value;
          closeDrop();
          updateOk();
          input.focus();
        },
      },
      ic,
      h('span', { class: 'ellipsis' }, label),
    );
    el.dataset.value = value;
    rows.push(el);
    return el;
  };
  drop = h(
    'div',
    { class: 'run-drop', role: 'listbox', style: { left: `${r.left}px`, top: `${r.bottom + 2}px`, width: `${r.width}px` } },
    hist.length ? h('div', { class: 'run-drop-h' }, t('run.history')) : null,
    hist.map((x) => row(x, x, icon('history', { size: 16 }))),
    apps.length ? h('div', { class: 'run-drop-h' }, t('run.apps')) : null,
    apps.map((a) => row(i18n.name(a.name), a.id, h('img', { src: registry.iconUrl(a.id), alt: '', width: 16, height: 16 }))),
  );
  drop._rows = rows;
  document.getElementById('overlays').appendChild(drop);
  const dr = drop.getBoundingClientRect();
  if (dr.bottom > window.innerHeight - 4) drop.style.top = `${Math.max(4, r.top - dr.height - 2)}px`;
}

function moveActive(d) {
  if (!drop) return openDrop(true);
  const rows = drop._rows;
  if (!rows.length) return;
  activeIdx = (activeIdx + d + rows.length) % rows.length;
  rows.forEach((x, i) => x.classList.toggle('active', i === activeIdx));
  input.value = rows[activeIdx].dataset.value;
  updateOk();
}

let okBtn = null;
function updateOk() {
  if (okBtn) okBtn.disabled = !input.value.trim();
}

let running = false;
async function execute() {
  const cmd = input?.value.trim();
  if (!cmd || running) return; // Enter pressed twice while the command is being resolved runs it once
  closeDrop();
  let action = null;
  running = true;
  try {
    action = await resolveCommand(cmd);
  } catch {
  } finally {
    running = false;
  }
  const fail = (msg) => ui.alert(msg, { title: t('run.title') }).then(() => input?.focus());
  if (!action) return fail(t('run.notFound', { cmd }));
  if (action.kind === 'url' && /^mailto:/i.test(action.url)) {
    if (!registry.get('mail')) return fail(t('run.notFound', { cmd }));
    shell.launch('mail', { mailto: action.url });
  } else if (action.kind === 'url') {
    if (!registry.get('browser')) return fail(t('run.noBrowser'));
    shell.openUrl(action.url);
  } else if (action.kind === 'path') {
    if (action.dir && !registry.get('files')) return fail(t('run.notFound', { cmd }));
    shell.openFile(action.path);
  } else if (action.kind === 'app') {
    if (!registry.get(action.appId)) return fail(t('run.notFound', { cmd }));
    shell.launch(action.appId, action.args);
  }
  saveHistory(cmd);
  win?.close();
}

async function browse() {
  closeDrop();
  const p = await ui.filePicker({ mode: 'open', title: t('run.browse').replace('…', '') });
  if (p && input) {
    input.value = /\s/.test(p) ? `"${p}"` : p;
    updateOk();
  }
  input?.focus();
}

export async function openRun() {
  if (win && wm.get(win.id)) {
    win.focus();
    input?.select();
    return win;
  }
  await loadHistory();
  const wa = wm.workarea();
  const W = 420;
  const H = 228;
  win = wm.create({
    appId: 'run',
    title: t('run.title'),
    icon: RUN_ICON,
    width: W,
    height: H,
    minWidth: W,
    minHeight: H,
    x: wa.x + 12,
    y: wa.y + wa.height - H - 12,
    resizable: false,
    maximizable: false,
    minimizable: false,
    background: 'solid',
    className: 'wm-run',
    skipTaskbar: true,
  });
  input = h('input', {
    class: 'input run-input',
    value: history[0] || '',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': t('run.open'),
    oninput: () => {
      updateOk();
      openDrop(false);
    },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveActive(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        execute();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (drop) closeDrop();
        else win?.close();
      }
    },
    onblur: () => setTimeout(() => document.activeElement !== input && closeDrop(), 100),
  });
  okBtn = h('button', { class: 'btn primary', onclick: execute }, t('common.ok'));
  const body = h(
    'div',
    { class: 'run' },
    h('div', { class: 'run-top' }, h('img', { class: 'run-icon', src: RUN_ICON, alt: '' }), h('div', { class: 'run-intro' }, t('run.intro'))),
    h(
      'label',
      { class: 'run-row' },
      h('span', { class: 'run-label' }, t('run.open')),
      h(
        'div',
        { class: 'run-combo' },
        input,
        h(
          'button',
          {
            class: 'run-dd',
            tabindex: '-1',
            'aria-label': t('run.showHistory'),
            onpointerdown: (e) => e.preventDefault(),
            onclick: (e) => {
              e.preventDefault();
              if (drop) closeDrop();
              else openDrop(true);
              input.focus();
            },
          },
          icon('chevron_down', { size: 12 }),
        ),
      ),
    ),
    h('div', { class: 'run-foot' }, okBtn, h('button', { class: 'btn', onclick: () => win?.close() }, t('common.cancel')), h('button', { class: 'btn', onclick: browse }, t('run.browse'))),
  );
  win.body.appendChild(body);
  updateOk();
  input.setAttribute('autofocus', '');
  const w = win;
  w.on('close', () => {
    closeDrop();
    if (win === w) {
      win = null;
      input = null;
      okBtn = null;
    }
  });
  w.on('move', closeDrop);
  w.on('blur', closeDrop);
  setTimeout(() => {
    input?.focus();
    input?.select();
  }, 30);
  return win;
}

export function mount(ctx) {
  ui.loadCss('app://shell/core/features/run.css');
  shell.on('run:open', () => openRun());
  i18n.on('change', () => {
    if (win) {
      const w = win;
      w.close(true).then(() => openRun());
    }
  });
  ctx.run = { open: openRun, resolve: resolveCommand, matchApp, scoreApp, parse: parseCommand };
}
