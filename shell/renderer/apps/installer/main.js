// Install Selene OS: the installer of the live session (Nocturne look: a night side panel with the steps
// drawn as moon phases, flat pages on the right).
//
// Steps: welcome (language) -> keyboard -> disk -> [space] -> account -> time zone -> [graphics driver] -> games -> summary
// -> installing -> done | error.
// The disk step picks the disk and, for a disk that already holds a system, how: « Installer à côté de Windows / Arch
// Linux… » (dual boot: UEFI + GPT, the probe's plans, see main/ipc/installer.js analyzeDisk) or « Effacer tout le
// disque ». « À côté » adds the space step (Selene's size, slider + number, both systems' resulting sizes); its summary
// lists the exact changes and asks to confirm a backup (checkbox) before « Installer ». Dual boot sizes come from the
// probe in MiB and are shown in binary units (« 476 Go » for 476 GiB), as Windows' Disk Management shows partitions;
// whole disks keep their decimal size (the label on the box). The graphics driver step only exists when an NVIDIA card is detected (installer:gpu):
// the recommended NVIDIA driver is then downloaded from the Ubuntu archive during the installation (needs the Internet).
// The games step (« Jeux ») offers the usual Linux gaming apps (Flathub, off by default): they are NOT downloaded
// during the installation; the helper records the choice (--gaming, ~/.config/aurora/first-login/gaming.json) and
// the session installs them for the new account at its first sign-in.
// The installer has its own UI language (chosen on the first page, switched live); it is also the
// language of the installed system. Backend: main/ipc/installer.js (installer:* channels), which runs
// /usr/lib/aurora/helpers/aurora-install as root (dry run in dev mode / outside the live session).
//
// Test hooks: the root element carries data-step / data-phase; window.__installer exposes the state.
import { ART, BRAND } from './art.js';

const BASE_STEPS = ['welcome', 'keyboard', 'disk', 'account', 'timezone', 'games', 'summary'];
const BASE_STAGES = ['partition', 'format', 'copy', 'configure', 'bootloader', 'cleanup'];
const RE_USER = /^[a-z_][a-z0-9_-]*$/;
const RE_HOST = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const RE_BADNAME = /[:,=\\\x00-\x1f\x7f]/;
const RESERVED = new Set(
  ('root daemon bin sys sync games man lp mail news uucp proxy www-data backup list irc gnats nobody systemd-network ' +
    'systemd-resolve systemd-timesync systemd-coredump messagebus syslog _apt tss uuidd tcpdump sshd polkitd _greetd ' +
    'greeter aurora-greeter admin sudo adm users wheel staff operator ubuntu').split(' '),
);
const DEFAULTS = {
  en: { keyboard: 'us', timezone: 'America/New_York' },
  fr: { keyboard: 'fr', timezone: 'Europe/Paris' },
};
const LOCALES = { en: 'en-US', fr: 'fr-FR' };

// Gaming apps offered by the « Jeux » step (Flathub ids: the same allow-list as main/ipc/installer.js GAMING_APPS
// and the helper's --gaming). Names are brand names (not translated); descriptions and sizes are in i18n.json
// (games.app.<key>.desc / .size, rough download hints).
export const GAMING_APPS = [
  { id: 'com.valvesoftware.Steam', key: 'steam', name: 'Steam', icon: 'game-controller', checked: true },
  { id: 'com.heroicgameslauncher.hgl', key: 'heroic', name: 'Heroic Games Launcher', short: 'Heroic', icon: 'rocket-launch', checked: true },
  { id: 'net.lutris.Lutris', key: 'lutris', name: 'Lutris', icon: 'stack', checked: true },
  { id: 'net.davidotek.pupgui2', key: 'protonup', name: 'ProtonUp-Qt', icon: 'sliders-horizontal', checked: true },
  { id: 'com.usebottles.bottles', key: 'bottles', name: 'Bottles', icon: 'flask', checked: false },
  { id: 'com.discordapp.Discord', key: 'discord', name: 'Discord', icon: 'chat-circle-dots', checked: false },
];

// ------------------------------------------------------------------ pure helpers (exported for tests)
/** Steps of the installer: the space step for a dual boot, the graphics driver step only for a computer with an
 * NVIDIA card, then the games step. */
export function stepsFor(gpu, mode) {
  const steps = gpu?.nvidia?.length ? [...BASE_STEPS.slice(0, -2), 'drivers', 'games', 'summary'] : BASE_STEPS.slice();
  if (mode === 'alongside') steps.splice(steps.indexOf('disk') + 1, 0, 'space');
  return steps;
}

/** Selene's size bounds for a dual boot option, in whole GiB: { min, max, def }. */
export function rootBoundsGiB(opt) {
  const min = Math.ceil(opt.rootMinMiB / 1024);
  const max = Math.floor(opt.rootMaxMiB / 1024);
  const def = Math.max(min, Math.min(max, Math.round((opt.rootSuggestedMiB || opt.rootMaxMiB) / 1024)));
  return { min, max, def };
}

/**
 * The exact dual boot plan for an option of the disk's analysis and a Selene size (GiB): the sizes to show and the
 * request for installer:start (main/ipc/installer.js alongsideArgs). Sizes in MiB.
 *   free:   { method, rootGiB, rootMiB, freeLeftMiB, request: { method, fingerprint, esp, start, end } }
 *   shrink: { method, rootGiB, rootMiB, oldMiB, newMiB, usedMiB, request: { method, fingerprint, esp, part, newSize, rootSize } }
 *   reuse:  { method, rootGiB, rootMiB, request: { method, fingerprint, esp, part } }   (the partition of a previous attempt: its size)
 */
export function alongsidePlan(analysis, opt, rootGiB) {
  if (!analysis?.possible || !opt || !analysis.esp) return null;
  if (opt.method === 'reuse') {
    return { method: 'reuse', rootGiB: Math.floor(opt.sizeMiB / 1024), rootMiB: opt.sizeMiB, request: { method: 'reuse', fingerprint: analysis.fingerprint, esp: analysis.esp.number, part: opt.number } };
  }
  const b = rootBoundsGiB(opt);
  if (b.max < b.min) return null;
  const g = Math.max(b.min, Math.min(b.max, Math.round(Number(rootGiB) || b.def)));
  const base = { fingerprint: analysis.fingerprint, esp: analysis.esp.number };
  if (opt.method === 'free') {
    const rootMiB = Math.max(opt.rootMinMiB, Math.min(g * 1024, opt.rootMaxMiB));
    return { method: 'free', rootGiB: g, rootMiB, freeLeftMiB: opt.sizeMiB - rootMiB, request: { method: 'free', ...base, start: opt.startMiB, end: opt.startMiB + rootMiB } };
  }
  // The new partition goes after the shrunk one (spaceMiB, minus 1 MiB of alignment) and has exactly the size shown:
  // rootSize is sent to the helper (--root-size), which creates that size, not « everything up to the next partition ».
  const newMiB = Math.max(opt.newMinMiB, Math.min(opt.newMaxMiB, opt.spaceMiB - 1 - g * 1024));
  const rootMiB = opt.spaceMiB - 1 - newMiB;
  return { method: 'shrink', rootGiB: g, rootMiB, oldMiB: opt.sizeMiB, newMiB, usedMiB: opt.usedMiB, request: { method: 'shrink', ...base, part: opt.number, newSize: newMiB, rootSize: rootMiB } };
}

/** Flathub ids to send to the helper (--gaming): none while the switch is off; catalog order, known ids only. */
export function gamingRequest(wanted, apps) {
  if (!wanted || !Array.isArray(apps)) return [];
  return GAMING_APPS.filter((a) => apps.includes(a.id)).map((a) => a.id);
}

/** Driver to ask the helper for: the recommended package when known, else 'recommended' (picked in the target). */
export function driverRequest(gpu, wanted) {
  if (!wanted || !gpu?.nvidia?.length || !gpu.online) return null;
  return gpu.recommended || 'recommended';
}

export function deriveUsername(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  let u = first
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (u && !/^[a-z_]/.test(u)) u = `u${u}`;
  return u.slice(0, 32);
}

export function deriveHostname(user) {
  const base = String(user || '').replace(/_/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 59).replace(/-+$/, '');
  return base ? `${base}-pc` : 'selene-pc';
}

export function passwordStrength(pw) {
  const p = String(pw || '');
  if (!p) return null;
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return s <= 2 ? 'weak' : s === 3 ? 'fair' : 'strong';
}

export function validateAccount(a) {
  const e = {};
  const full = String(a.fullname || '').trim();
  if (!full) e.fullname = 'account.err.fullname';
  else if (RE_BADNAME.test(full) || full.length > 128) e.fullname = 'account.err.fullnameChars';
  const u = String(a.user || '');
  if (!u || !RE_USER.test(u)) e.user = 'account.err.username';
  else if (u.length > 32) e.user = 'account.err.usernameLong';
  else if (RESERVED.has(u)) e.user = 'account.err.usernameReserved';
  if (!a.password) e.password = 'account.err.password';
  if (a.password && a.confirm !== a.password) e.confirm = 'account.err.mismatch';
  if (!RE_HOST.test(String(a.hostname || ''))) e.hostname = 'account.err.hostname';
  return e;
}

/** 'Europe/Paris' -> { id, city, region, sub, offset (minutes), offsetLabel } (null if the zone is unknown to ICU) */
export function zoneInfo(id, now = new Date()) {
  let offset = 0;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'longOffset' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
    if (m) offset = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch {
    return null;
  }
  const parts = id.split('/');
  const sign = offset < 0 ? '−' : '+';
  const abs = Math.abs(offset);
  const offsetLabel = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return {
    id,
    city: (parts.length > 1 ? parts[parts.length - 1] : id).replace(/_/g, ' '),
    region: parts.length > 1 ? parts[0] : 'Etc',
    sub: parts.length > 2 ? parts[1].replace(/_/g, ' ') : '',
    offset,
    offsetLabel,
  };
}

/** MiB -> « 400 Go »: binary units, as Windows' Disk Management shows partitions (the probe counts in MiB). */
function fmtGiB(mib, lang) {
  const v = (Number(mib) || 0) / 1024;
  if (v < 1) return `${new Intl.NumberFormat(LOCALES[lang], { maximumFractionDigits: 0 }).format(Number(mib) || 0)} ${lang === 'fr' ? 'Mo' : 'MB'}`;
  return `${new Intl.NumberFormat(LOCALES[lang], { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} ${lang === 'fr' ? 'Go' : 'GB'}`;
}

function fmtSize(bytes, lang) {
  const units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const n = new Intl.NumberFormat(LOCALES[lang], { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v);
  return `${n} ${units[i]}`;
}

// ------------------------------------------------------------------ app
export default {
  async launch(ctx) {
    const { win, h, icon, ui, api } = ctx;
    const dict = await fetch(ctx.appUrl('i18n.json'))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    const status = await api.invoke('installer:status').catch(() => ({ dryRun: true, minSize: 12e9 }));
    const [keyboards, zones] = await Promise.all([
      api.invoke('installer:keyboards').catch(() => []),
      api.invoke('installer:timezones').catch(() => ['UTC']),
    ]);

    let STEPS = BASE_STEPS.slice();
    let STAGES = BASE_STAGES.slice();
    const S = {
      gpu: null, // installer:gpu result (null while probing)
      driverWanted: true, // « Install the recommended NVIDIA driver » (on by default when online)
      driverTouched: false,
      driverChecking: false,
      driverRequested: null, // package (or 'recommended') sent to the helper
      driverResult: null, // { status: 'installed'|'failed', pkg, message }
      gamingWanted: false, // « Installer les applications de jeu » (off by default)
      gamingApps: GAMING_APPS.filter((a) => a.checked).map((a) => a.id), // checked in the list
      gamingRequested: [], // ids sent to the helper (--gaming)
      gamingResult: null, // { status: 'saved'|'failed', apps, message }
      lang: ctx.lang === 'fr' ? 'fr' : 'en',
      step: 0,
      phase: 'setup', // setup | installing | done | error
      keyboard: null,
      keyboardTouched: false,
      kbQuery: '',
      disks: null,
      disksError: null,
      disk: null,
      mode: null, // 'erase' | 'alongside' (dual boot) for the chosen disk
      method: null, // dual boot: index of the chosen option of the disk's analysis (free space / shrink a partition)
      rootGiB: null, // dual boot: size of Selene OS (GiB)
      backupOk: false, // dual boot: « J'ai sauvegardé mes fichiers importants »
      bootEntry: null, // { status: 'added'|'failed'|'skipped', message } (dual boot)
      fullname: '',
      user: '',
      userTouched: false,
      password: '',
      confirm: '',
      hostname: '',
      hostTouched: false,
      autologin: false,
      touched: {},
      timezone: null,
      tzTouched: false,
      tzQuery: '',
      progress: 0,
      stage: null,
      stageMessage: '',
      log: [],
      showDetails: false,
      error: null,
      cancelled: false,
      cancelling: false,
      dryRun: !!status.dryRun,
    };
    const applyDefaults = () => {
      if (!S.keyboardTouched) S.keyboard = DEFAULTS[S.lang].keyboard;
      if (!S.tzTouched) S.timezone = zones.includes(DEFAULTS[S.lang].timezone) ? DEFAULTS[S.lang].timezone : 'UTC';
    };
    applyDefaults();

    // ---------------------------------------------------------------- i18n (own language, switched live)
    const lookup = (o, key) => key.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
    const t = (key, vars) => {
      let v;
      if (vars && vars.count !== undefined) {
        const cat = new Intl.PluralRules(LOCALES[S.lang]).select(vars.count);
        v = lookup(dict[S.lang], `${key}_${cat}`) ?? lookup(dict[S.lang], `${key}_other`);
      }
      v = v ?? lookup(dict[S.lang], key) ?? lookup(dict.en, key);
      if (typeof v !== 'string') return key;
      // FR « à côté de Windows » / « à côté d'Arch Linux »: {de_os} is derived from {os}.
      if (vars && vars.os !== undefined && vars.de_os === undefined) vars = { ...vars, de_os: /^[aeiouyàâäéèêëîïôöùûü]/i.test(String(vars.os)) ? `d'${vars.os}` : `de ${vars.os}` };
      return v.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
    };
    const size = (b) => fmtSize(b, S.lang);

    // ---------------------------------------------------------------- skeleton
    const art = h('div', { class: 'ins-art', 'aria-hidden': 'true' });
    const stepper = h('ol', { class: 'ins-steps' });
    const kicker = h('div', { class: 'ins-kicker' });
    const title = h('h1', { class: 'ins-title', id: `ins-title-${win.id}` });
    const subtitle = h('p', { class: 'ins-sub' });
    const content = h('div', { class: 'ins-content' });
    const footLeft = h('div', { class: 'ins-foot-left' });
    const footRight = h('div', { class: 'ins-foot-right' });
    const page = h(
      'section',
      { class: 'ins-page', 'aria-labelledby': `ins-title-${win.id}` },
      h('header', { class: 'ins-head' }, h('div', { class: 'ins-head-text' }, kicker, title, subtitle), art),
      content,
    );
    // The side panel is always a night scene (dark tokens, lunar wallpaper), in light mode too.
    const brand = h('div', { class: 'ins-brand', html: `${BRAND(30)}<span class="ins-brand-name">Selene OS</span>` });
    const root = h(
      'div',
      { class: 'ins', dataset: { step: STEPS[0], phase: 'setup' } },
      h('aside', { class: 'ins-side', 'data-theme-scope': true, dataset: { theme: 'dark' } }, brand, stepper),
      h('main', { class: 'ins-main' }, page, h('footer', { class: 'ins-foot' }, footLeft, footRight)),
    );
    win.body.appendChild(root);

    const btn = (label, onclick, { primary = false, cls = '', disabled = false, id } = {}) =>
      h('button', { class: ['btn', primary && 'primary', cls], onclick, disabled, dataset: id ? { act: id } : null }, label);

    // ---------------------------------------------------------------- navigation + validation
    const stepValid = (name = STEPS[S.step]) => {
      switch (name) {
        case 'keyboard':
          return !!S.keyboard;
        case 'disk': {
          const d = S.disks?.find((x) => x.path === S.disk && !x.tooSmall);
          return !!d && (S.mode === 'erase' || (S.mode === 'alongside' && !!d.alongside?.possible));
        }
        case 'space':
          return !!currentPlan();
        case 'summary':
          return S.mode !== 'alongside' || (!!currentPlan() && S.backupOk);
        case 'account':
          return Object.keys(validateAccount(S)).length === 0;
        case 'timezone':
          return !!S.timezone;
        default:
          return true;
      }
    };
    // Dual boot: the disk's analysis, the chosen option and the exact plan.
    const diskObj = () => S.disks?.find((d) => d.path === S.disk);
    const analysis = () => (S.mode === 'alongside' ? diskObj()?.alongside || null : null);
    const option = () => analysis()?.options?.[S.method ?? 0] || null;
    const currentPlan = () => (S.mode === 'alongside' ? alongsidePlan(analysis(), option(), S.rootGiB) : null);
    const osName = (a = diskObj()?.alongside) => a?.os || t('disk.otherSystem');
    function setMode(mode) {
      const cur = STEPS[S.step];
      S.mode = mode;
      S.backupOk = false;
      if (mode === 'alongside') {
        const a = diskObj()?.alongside;
        S.method = 0;
        S.rootGiB = a?.options?.[0] ? rootBoundsGiB(a.options[0]).def : null;
      }
      STEPS = stepsFor(S.gpu, S.mode);
      S.step = Math.max(0, STEPS.indexOf(cur));
    }

    const go = (i) => {
      S.step = Math.max(0, Math.min(STEPS.length - 1, i));
      render();
    };
    const next = () => {
      if (S.phase !== 'setup') return;
      if (!stepValid()) {
        if (STEPS[S.step] === 'account') {
          for (const k of ['fullname', 'user', 'password', 'confirm', 'hostname']) S.touched[k] = true;
          refreshAccount?.();
        }
        return;
      }
      if (STEPS[S.step] === 'summary') return startInstall();
      go(S.step + 1);
    };
    const back = () => S.phase === 'setup' && S.step > 0 && go(S.step - 1);

    // ---------------------------------------------------------------- chrome (art, stepper, header, footer)
    function renderChrome(artName) {
      art.innerHTML = ART[artName]?.() || '';
      stepper.replaceChildren(
        ...[...STEPS, 'install'].map((s, i) => {
          const installIdx = STEPS.length;
          let state = 'todo';
          if (S.phase === 'setup') state = i < S.step ? 'done' : i === S.step ? 'current' : 'todo';
          else state = i < installIdx ? 'done' : S.phase === 'done' ? 'done' : 'current';
          const clickable = S.phase === 'setup' && i < S.step;
          return h(
            'li',
            { class: ['ins-step', state], 'aria-current': state === 'current' ? 'step' : null },
            h(
              'button',
              { class: 'ins-step-btn', disabled: !clickable, tabindex: clickable ? 0 : -1, onclick: () => clickable && go(i) },
              // Moon phase: new moon (to do), half moon (current), full moon (done); drawn in CSS.
              h('span', { class: 'ins-step-dot', 'aria-hidden': 'true' }),
              h('span', { class: 'ins-step-label' }, t(`steps.${s}`)),
            ),
          );
        }),
      );
      win.setTitle(t('title'));
      footLeft.replaceChildren();
      if (S.dryRun && S.phase !== 'done') {
        footLeft.appendChild(h('span', { class: 'ins-badge', 'data-tip': t('simulationTip'), title: t('simulationTip') }, icon('info', { size: 14 }), t('simulation')));
      }
    }

    const stepOf = (name) => t('stepOf', { n: STEPS.indexOf(name) + 1, total: STEPS.length });
    function setHeader(k, ttl, sub) {
      kicker.textContent = k || '';
      kicker.hidden = !k;
      title.textContent = ttl;
      subtitle.textContent = sub || '';
      subtitle.hidden = !sub;
    }

    function setupFooter() {
      const last = STEPS[S.step] === 'summary';
      footRight.replaceChildren(
        ...[S.step > 0 ? btn(t('back'), back, { id: 'back' }) : null, btn(last ? t('install') : t('next'), next, { primary: true, id: 'next', disabled: !stepValid() })].filter(Boolean),
      );
    }
    const refreshNext = () => {
      const b = footRight.querySelector('[data-act="next"]');
      if (b) b.disabled = !stepValid();
    };

    // ---------------------------------------------------------------- lists with keyboard navigation
    function listbox(items, { selected, onSelect, render: renderItem, label, cls = '' }) {
      const el = h('div', { class: ['ins-list', cls], role: 'listbox', 'aria-label': label, tabindex: 0 });
      const rows = items.map((it) =>
        h(
          'div',
          {
            class: ['ins-row', it.id === selected && 'selected', it.disabled && 'disabled'],
            role: 'option',
            'aria-selected': it.id === selected ? 'true' : 'false',
            'aria-disabled': it.disabled ? 'true' : null,
            dataset: { id: it.id },
            onclick: () => !it.disabled && onSelect(it.id),
          },
          renderItem(it),
        ),
      );
      el.append(...rows);
      el.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const enabled = items.filter((x) => !x.disabled);
        if (!enabled.length) return;
        let i = enabled.findIndex((x) => x.id === selected);
        if (e.key === 'ArrowDown') i = Math.min(enabled.length - 1, i + 1);
        else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
        else if (e.key === 'Home') i = 0;
        else i = enabled.length - 1;
        onSelect(enabled[i].id, { keyboard: true });
      });
      setTimeout(() => el.querySelector('.ins-row.selected')?.scrollIntoView({ block: 'nearest' }), 0);
      return el;
    }

    // ---------------------------------------------------------------- pages
    let refreshAccount = null;

    function pageWelcome() {
      setHeader(null, t('welcome.title'), t('welcome.subtitle'));
      const opt = (lang, badge, name, region) =>
        h(
          'button',
          {
            class: ['ins-option', S.lang === lang && 'selected'],
            role: 'radio',
            'aria-checked': S.lang === lang ? 'true' : 'false',
            dataset: { lang },
            onclick: () => {
              if (S.lang === lang) return;
              S.lang = lang;
              applyDefaults();
              render();
              root.querySelector(`.ins-option[data-lang="${lang}"]`)?.focus();
            },
          },
          h('span', { class: 'ins-option-badge' }, badge),
          h('span', { class: 'ins-option-text' }, h('span', { class: 'ins-option-name' }, name), h('span', { class: 'ins-option-desc' }, region)),
          h('span', { class: 'ins-option-check' }, icon('checkmark_circle', { size: 20, filled: true })),
        );
      content.replaceChildren(
        h(
          'div',
          { class: 'ins-langs', role: 'radiogroup', 'aria-label': t('steps.welcome') },
          opt('en', 'EN', t('welcome.enName'), t('welcome.enRegion')),
          opt('fr', 'FR', t('welcome.frName'), t('welcome.frRegion')),
        ),
        h('div', { class: 'infobar ins-note' }, icon('info', { size: 16 }), h('div', null, t('welcome.note'))),
        // Under 4 GB of RAM (a "4 GB" machine reports ~3.7 GiB): a warning, the install stays possible.
        status.memTotal && status.memTotal < 3.5 * 1024 ** 3
          ? h('div', { class: 'infobar warning ins-note ins-lowram', role: 'note' }, icon('warning', { size: 16 }), h('div', null, t('welcome.lowRam', { ram: `${(status.memTotal / 1024 ** 3).toFixed(1).replace('.', S.lang === 'fr' ? ',' : '.')} ${S.lang === 'fr' ? 'Go' : 'GB'}` })))
          : null,
      );
    }

    function pageKeyboard() {
      setHeader(stepOf('keyboard'), t('keyboard.title'), t('keyboard.subtitle'));
      const q = S.kbQuery.trim().toLowerCase();
      const items = keyboards
        .map((k) => ({ ...k, label: k.name[S.lang] || k.name.en }))
        .filter((k) => !q || k.label.toLowerCase().includes(q) || k.id.includes(q) || (k.name.en || '').toLowerCase().includes(q));
      const search = h('input', {
        class: 'input ins-search',
        type: 'search',
        placeholder: t('keyboard.search'),
        value: S.kbQuery,
        'aria-label': t('keyboard.search'),
        oninput: (e) => {
          S.kbQuery = e.target.value;
          const pos = e.target.selectionStart;
          pageKeyboard();
          const s = content.querySelector('.ins-search');
          s.focus();
          s.setSelectionRange(pos, pos);
        },
      });
      const select = (id, o = {}) => {
        S.keyboard = id;
        S.keyboardTouched = true;
        api.invoke('installer:applyKeyboard', id).catch(() => {});
        content.querySelectorAll('.ins-list .ins-row').forEach((r) => {
          const on = r.dataset.id === id;
          r.classList.toggle('selected', on);
          r.setAttribute('aria-selected', on ? 'true' : 'false');
          if (on && o.keyboard) r.scrollIntoView({ block: 'nearest' });
        });
        refreshNext();
      };
      const list = items.length
        ? listbox(items, {
            selected: S.keyboard,
            label: t('steps.keyboard'),
            onSelect: select,
            render: (k) => [
              h('span', { class: 'ins-row-icon' }, icon('keyboard', { size: 20 })),
              h('span', { class: 'ins-row-main' }, h('span', { class: 'ins-row-title' }, k.label)),
              h('span', { class: 'ins-row-meta mono' }, k.id),
              h('span', { class: 'ins-row-check' }, icon('checkmark', { size: 16 })),
            ],
          })
        : h('div', { class: 'ins-empty' }, t('keyboard.none', { q: S.kbQuery }));
      content.replaceChildren(
        search,
        list,
        h(
          'label',
          { class: 'ins-field ins-test' },
          h('span', { class: 'ins-label' }, t('keyboard.test')),
          h('input', { class: 'input', type: 'text', spellcheck: false, autocomplete: 'off', placeholder: 'azerty qwerty àéèç' }),
          h('span', { class: 'ins-hint' }, t('keyboard.testHint')),
        ),
      );
    }

    async function loadDisks() {
      S.disks = null;
      S.disksError = null;
      if (STEPS[S.step] === 'disk') pageDisk();
      try {
        S.disks = await api.invoke('installer:disks');
      } catch (e) {
        S.disks = [];
        S.disksError = e.message;
      }
      if (S.disk && !S.disks.find((d) => d.path === S.disk && !d.tooSmall)) S.disk = null;
      const usable = S.disks.filter((d) => !d.tooSmall);
      if (!S.disk && usable.length === 1) S.disk = usable[0].path;
      // After a refresh the analysis is new: a dual boot that is no longer possible is dropped, its size re-clamped.
      const cur = diskObj();
      if (!cur) setMode(null);
      else if (!cur.partitions.length) setMode('erase');
      else if (S.mode === 'alongside' && !cur.alongside?.possible) setMode(null);
      else if (S.mode === 'alongside') {
        if (!option()) S.method = 0;
        S.rootGiB = alongsidePlan(cur.alongside, option(), S.rootGiB)?.rootGiB ?? null;
      }
      if (STEPS[S.step] === 'disk' && S.phase === 'setup') {
        pageDisk();
        refreshNext();
      }
    }

    function partBar(d) {
      if (!d.partitions.length) return h('div', { class: 'ins-parts is-free' }, h('span', { class: 'ins-part free', style: { flexGrow: '1' } }));
      return h(
        'div',
        { class: 'ins-parts' },
        d.partitions.map((p, i) =>
          h('span', {
            class: ['ins-part', `c${i % 4}`],
            style: { flexGrow: String(Math.max(p.size / d.size, 0.02)) },
            title: `${p.path} · ${p.label || p.fstype || '—'} · ${size(p.size)}`,
          }),
        ),
      );
    }

    function pageDisk() {
      setHeader(stepOf('disk'), t('disk.title'), t('disk.subtitle'));
      const refresh = h('button', { class: 'btn subtle small ins-refresh', onclick: loadDisks, 'data-act': 'refresh' }, icon('arrow_sync', { size: 16 }), t('refresh'));
      let body;
      if (S.disks == null) {
        body = h('div', { class: 'ins-loading' }, h('div', { class: 'spinner small' }), t('disk.loading'));
      } else if (!S.disks.length) {
        body = h(
          'div',
          { class: 'ins-empty big' },
          icon('hard_drive', { size: 40 }),
          h('div', { class: 'body-strong' }, S.disksError ? t('disk.loadError', { error: S.disksError }) : t('disk.none')),
          h('div', { class: 'text-2' }, t('disk.noneHint', { size: size(status.minSize || 12e9) })),
        );
      } else {
        const select = (id) => {
          if (S.disk !== id) {
            S.disk = id;
            // A disk without partitions can only be used whole; otherwise the person chooses (nothing preselected).
            setMode(diskObj()?.partitions?.length ? null : 'erase');
            renderChrome('disk');
          }
          pageDisk();
          refreshNext();
          content.querySelector('.ins-list')?.focus();
        };
        body = listbox(
          S.disks.map((d) => ({ ...d, id: d.path, disabled: d.tooSmall })),
          {
            selected: S.disk,
            label: t('steps.disk'),
            cls: 'ins-disks',
            onSelect: select,
            render: (d) => {
              const parts = d.partitions.length
                ? `${t('disk.partitions', { count: d.partitions.length })} · ${d.partitions.map((p) => p.label || p.fstype).filter(Boolean).join(', ')}`
                : t('disk.empty');
              return [
                h('span', { class: 'ins-row-icon big' }, icon(d.removable || d.transport === 'usb' ? 'usb_stick' : 'hard_drive', { size: 28 })),
                h(
                  'span',
                  { class: 'ins-row-main' },
                  h('span', { class: 'ins-row-title' }, d.model || t('disk.unknownModel'), d.removable ? h('span', { class: 'ins-tag' }, t('disk.removable')) : null),
                  h('span', { class: 'ins-row-sub' }, [d.path, d.transport ? d.transport.toUpperCase() : null].filter(Boolean).join(' · ')),
                  partBar(d),
                  h('span', { class: ['ins-row-sub', d.tooSmall && 'ins-err-text'] }, d.tooSmall ? t('disk.tooSmall', { size: size(status.minSize || 12e9) }) : [d.alongside?.systems?.map((x) => x.name).join(', '), parts].filter(Boolean).join(' · ')),
                ),
                h('span', { class: 'ins-row-size' }, size(d.size)),
                h('span', { class: 'ins-row-check' }, icon('checkmark', { size: 16 })),
              ];
            },
          },
        );
      }
      const sel = S.disks?.find((d) => d.path === S.disk && !d.tooSmall);
      const chooser = sel && sel.partitions.length ? modeChooser(sel) : null;
      content.replaceChildren(
        ...[
          h('div', { class: 'ins-toolbar' }, refresh),
          body,
          chooser || h('div', { class: 'infobar warning ins-warning', role: 'note' }, icon('warning', { size: 16 }), h('div', null, t('disk.warning'))),
        ],
      );
      if (chooser && STEPS[S.step] === 'disk') setTimeout(() => chooser.scrollIntoView?.({ block: 'nearest' }), 0);
    }

    // « Installer à côté de … » / « Effacer tout le disque » for a disk that holds something.
    function modeChooser(d) {
      const a = d.alongside || {};
      const os = a.os;
      const showAlong = a.possible || (a.systems || []).length > 0;
      const pick = (mode) => {
        if (mode === 'alongside' && !a.possible) return;
        if (S.mode !== mode) setMode(mode);
        render();
        content.querySelector(`.ins-mode[data-mode="${mode}"]`)?.focus();
      };
      const card = (mode, ic, ttl, desc, { disabled = false, danger = false, extra = null } = {}) => {
        const on = S.mode === mode;
        return h(
          'div',
          {
            class: ['ins-mode', on && 'selected', disabled && 'disabled', danger && 'danger'],
            role: 'radio',
            tabindex: disabled ? -1 : 0,
            'aria-checked': on ? 'true' : 'false',
            'aria-disabled': disabled ? 'true' : null,
            dataset: { mode },
            onclick: () => pick(mode),
            onkeydown: (e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                if (e.key === 'Enter' && on) return; // Enter on the chosen card = Next
                e.preventDefault();
                e.stopPropagation();
                pick(mode);
              }
            },
          },
          h('span', { class: 'ins-mode-radio', 'aria-hidden': 'true' }),
          h('span', { class: 'ins-mode-icon', 'aria-hidden': 'true' }, icon(ic, { size: 22 })),
          h('span', { class: 'ins-mode-text' }, h('span', { class: 'ins-mode-title' }, ttl), h('span', { class: 'ins-mode-desc' }, desc), extra),
        );
      };
      const reason = !a.possible && a.reason ? whyBlock(a, d) : null;
      return h(
        'div',
        { class: 'ins-modes', role: 'radiogroup', 'aria-label': t('disk.modeLabel') },
        showAlong
          ? card('alongside', 'split_vertical', t('disk.alongside', { os: os || t('disk.otherSystem') }), t('disk.alongsideDesc', { os: os || t('disk.otherSystem') }), { disabled: !a.possible, extra: reason })
          : null,
        card('erase', 'delete', t('disk.erase'), os ? t('disk.eraseDesc', { os }) : t('disk.eraseDescPlain'), { danger: true }),
        S.mode == null ? h('div', { class: 'ins-hint ins-mode-hint' }, t('disk.chooseMode')) : null,
      );
    }

    // Why « à côté » is not possible, and what the person can do about it.
    function whyBlock(a, d) {
      const vars = { os: a.reasonOs || a.os || t('disk.otherSystem'), fs: a.reasonFs || '', part: a.reasonPart || d.path, free: fmtGiB(a.esp?.freeMiB || 0, S.lang) };
      return h(
        'span',
        { class: 'ins-why', role: 'note', dataset: { reason: a.reason } },
        h('span', { class: 'ins-why-title' }, icon('info', { size: 14 }), t(`why.${a.reason}.title`, vars)),
        h('span', { class: 'ins-why-body' }, t(`why.${a.reason}.body`, vars)),
      );
    }

    // ---------------------------------------------------------------- space (dual boot): Selene's size
    const partName = (o) => (o.kind === 'windows' ? t('part.windows') : o.os ? t('part.linux', { os: o.os, part: o.part.replace(/^\/dev\//, '') }) : t('part.other', { part: o.part.replace(/^\/dev\//, '') }));
    function pageSpace() {
      const d = diskObj();
      const a = analysis();
      if (!d || !a) return;
      const os = osName(a);
      setHeader(stepOf('space'), t('space.title'), t('space.subtitle', { os, disk: d.model || d.path }));
      const opts = a.options;
      const opt = option();
      const b = rootBoundsGiB(opt);
      const g = (x) => fmtGiB(x, S.lang);
      const methods =
        opts.length > 1
          ? h(
              'div',
              { class: 'ins-methods', role: 'radiogroup', 'aria-label': t('space.methodLabel') },
              opts.map((o, i) =>
                h(
                  'button',
                  {
                    class: ['ins-method', (S.method ?? 0) === i && 'selected'],
                    role: 'radio',
                    'aria-checked': (S.method ?? 0) === i ? 'true' : 'false',
                    dataset: { method: o.method },
                    onclick: () => {
                      if ((S.method ?? 0) === i) return;
                      S.method = i;
                      S.rootGiB = rootBoundsGiB(o).def;
                      S.backupOk = false;
                      pageSpace();
                      refreshNext();
                      content.querySelector(`.ins-method[data-method="${o.method}"]`)?.focus();
                    },
                  },
                  h('span', { class: 'ins-mode-radio', 'aria-hidden': 'true' }),
                  h(
                    'span',
                    { class: 'ins-mode-text' },
                    h('span', { class: 'ins-mode-title' }, o.method === 'reuse' ? t('space.reuse') : o.method === 'free' ? t('space.useFree') : t('space.shrink', { name: partName(o) })),
                    h(
                      'span',
                      { class: 'ins-mode-desc' },
                      o.method === 'reuse' ? t('space.reuseDesc', { size: g(o.sizeMiB), part: o.part.replace(/^\/dev\//, '') }) : o.method === 'free' ? t('space.useFreeDesc', { size: g(o.sizeMiB) }) : t('space.shrinkDesc', { size: g(o.sizeMiB), used: g(o.usedMiB) }),
                    ),
                  ),
                ),
              ),
            )
          : null;
      // The split: the other system (or the free space left) and Selene, to scale.
      const bar = h('div', { class: 'ins-split', 'aria-hidden': 'true' });
      const legend = h('div', { class: 'ins-split-legend' });
      if (opt.method === 'reuse') {
        // The partition of the previous attempt: its size is fixed, nothing else on the disk changes.
        const plan = alongsidePlan(a, opt);
        S.rootGiB = plan.rootGiB;
        bar.replaceChildren(h('span', { class: 'ins-split-part selene', style: { flexGrow: '1' } }));
        legend.replaceChildren(h('span', { class: 'ins-legend selene', dataset: { k: 'selene' } }, h('span', { class: 'ins-dot selene' }), h('span', { class: 'ins-legend-name' }, 'Selene OS'), h('strong', { class: 'ins-legend-size' }, g(plan.rootMiB))));
        content.replaceChildren(
          ...[
            methods,
            h('div', { class: 'ins-space card' }, bar, legend),
            h('div', { class: 'ins-space-note' }, h('div', { class: 'ins-space-line', dataset: { k: 'reuse' } }, icon('info', { size: 16 }), h('span', null, t('space.reuseNote', { size: g(plan.rootMiB), os })))),
          ].filter(Boolean),
        );
        refreshNext();
        return;
      }
      const note = h('div', { class: 'ins-space-note', 'aria-live': 'polite' });
      const range = h('input', { type: 'range', class: 'slider ins-range', min: b.min, max: b.max, step: 1, value: S.rootGiB ?? b.def, 'aria-label': t('space.sizeLabel') });
      const num = h('input', { type: 'number', class: 'input ins-num', min: b.min, max: b.max, step: 1, value: S.rootGiB ?? b.def, 'aria-label': `${t('space.sizeLabel')} (${t('space.unit')})` });
      const update = (v, from) => {
        const plan = alongsidePlan(a, opt, v);
        S.rootGiB = plan.rootGiB;
        if (from !== range) range.value = String(plan.rootGiB);
        range.style.setProperty('--val', `${b.max > b.min ? ((plan.rootGiB - b.min) / (b.max - b.min)) * 100 : 100}%`);
        if (from !== num) num.value = String(plan.rootGiB);
        const total = opt.method === 'free' ? opt.sizeMiB : opt.spaceMiB;
        const left = opt.method === 'free' ? plan.freeLeftMiB : plan.newMiB;
        const leftLabel = opt.method === 'free' ? t('space.free') : opt.os || os;
        bar.replaceChildren(
          h('span', { class: ['ins-split-part', opt.method === 'free' ? 'free' : 'other'], style: { flexGrow: String(Math.max(left / total, 0.001)) } }, opt.method === 'shrink' ? h('span', { class: 'ins-split-used', style: { width: `${Math.min(100, (plan.usedMiB / Math.max(left, 1)) * 100)}%` } }) : null),
          h('span', { class: 'ins-split-part selene', style: { flexGrow: String(plan.rootMiB / total) } }),
        );
        legend.replaceChildren(
          h('span', { class: 'ins-legend other', dataset: { k: 'other' } }, h('span', { class: ['ins-dot', opt.method === 'free' ? 'free' : 'other'] }), h('span', { class: 'ins-legend-name' }, leftLabel), h('strong', { class: 'ins-legend-size' }, g(left))),
          h('span', { class: 'ins-legend selene', dataset: { k: 'selene' } }, h('span', { class: 'ins-dot selene' }), h('span', { class: 'ins-legend-name' }, 'Selene OS'), h('strong', { class: 'ins-legend-size' }, g(plan.rootMiB))),
        );
        note.replaceChildren(
          ...[
            opt.method === 'shrink'
              ? h('div', { class: 'ins-space-line', dataset: { k: 'keeps' } }, icon('info', { size: 16 }), h('span', null, t('space.keeps', { os: opt.os || os, from: g(plan.oldMiB), size: g(plan.newMiB), used: g(plan.usedMiB), free: g(plan.newMiB - plan.usedMiB) })))
              : plan.freeLeftMiB >= 1024
                ? h('div', { class: 'ins-space-line', dataset: { k: 'freeLeft' } }, icon('info', { size: 16 }), h('span', null, t('space.freeLeft', { size: g(plan.freeLeftMiB) })))
                : null,
            plan.rootMiB < a.rootSuggestedMiB - 512 ? h('div', { class: 'ins-space-line warn', dataset: { k: 'small' } }, icon('warning', { size: 16 }), h('span', null, t('space.small', { suggested: g(a.rootSuggestedMiB) }))) : null,
            opt.method === 'shrink' && opt.fstype === 'ext4' ? h('div', { class: 'ins-space-line', dataset: { k: 'slow' } }, icon('clock', { size: 16 }), h('span', null, t('space.slowExt4'))) : null,
          ].filter(Boolean),
        );
        refreshNext();
      };
      range.addEventListener('input', () => update(range.value, range));
      num.addEventListener('input', () => {
        const v = Number(num.value);
        if (Number.isFinite(v) && v >= b.min && v <= b.max) update(v, num);
      });
      num.addEventListener('change', () => update(num.value, null));
      content.replaceChildren(
        ...[
          methods,
          h('div', { class: 'ins-space card' }, bar, legend, h('div', { class: 'ins-size-row' }, h('label', { class: 'ins-label', for: `ins-num-${win.id}` }, t('space.sizeLabel')), range, h('span', { class: 'ins-num-wrap' }, num, h('span', { class: 'ins-unit' }, t('space.unit'))))),
          h('div', { class: 'ins-hint ins-bounds' }, t('space.bounds', { min: g(b.min * 1024), suggested: g(a.rootSuggestedMiB), max: g(b.max * 1024) })),
          note,
          a.bitlocker ? h('div', { class: 'infobar warning ins-note ins-bitlocker', role: 'note' }, icon('shield_keyhole', { size: 16 }), h('div', null, t('space.bitlockerKey'))) : null,
        ].filter(Boolean),
      );
      num.id = `ins-num-${win.id}`;
      update(S.rootGiB ?? b.def, null);
    }

    function field(key, label, input, hint) {
      return h('label', { class: 'ins-field', dataset: { field: key } }, h('span', { class: 'ins-label' }, label), input, hint ? h('span', { class: 'ins-hint' }, hint) : null, h('span', { class: 'ins-err', role: 'alert' }));
    }

    function pageAccount() {
      setHeader(stepOf('account'), t('account.title'), t('account.subtitle'));
      const inp = (key, props = {}) =>
        h('input', {
          class: 'input',
          value: S[key],
          name: key,
          autocomplete: 'off',
          spellcheck: false,
          ...props,
          oninput: (e) => {
            S[key] = e.target.value;
            if (key === 'fullname' && !S.userTouched) {
              S.user = deriveUsername(S.fullname);
              userIn.value = S.user;
            }
            if (key === 'user') S.userTouched = true;
            if (key === 'hostname') S.hostTouched = true;
            if ((key === 'fullname' || key === 'user') && !S.hostTouched) {
              S.hostname = deriveHostname(S.user);
              hostIn.value = S.hostname;
            }
            S.touched[key] = true;
            refreshAccount();
          },
          onblur: () => {
            S.touched[key] = true;
            refreshAccount();
          },
        });
      const fullIn = inp('fullname', { placeholder: t('account.fullnamePh'), maxlength: 128 });
      const userIn = inp('user', { maxlength: 32 });
      const pwIn = inp('password', { type: 'password', autocomplete: 'new-password' });
      const cfIn = inp('confirm', { type: 'password', autocomplete: 'new-password' });
      const hostIn = inp('hostname', { maxlength: 63 });
      const eye = h(
        'button',
        {
          class: 'btn subtle icon-btn ins-eye',
          type: 'button',
          title: t('account.showPassword'),
          'aria-label': t('account.showPassword'),
          'aria-pressed': 'false',
          onclick: (e) => {
            e.preventDefault();
            const show = pwIn.type === 'password';
            pwIn.type = cfIn.type = show ? 'text' : 'password';
            eye.setAttribute('aria-pressed', show ? 'true' : 'false');
            eye.replaceChildren(icon(show ? 'eye_off' : 'eye', { size: 16 }));
          },
        },
        icon('eye', { size: 16 }),
      );
      const meter = h('div', { class: 'ins-meter', 'aria-live': 'polite' }, h('div', { class: 'ins-meter-bars' }, h('span'), h('span'), h('span')), h('span', { class: 'ins-meter-label' }));
      const auto = ui.toggle({
        checked: S.autologin,
        label: t('account.autologin'),
        onchange: (v) => {
          S.autologin = v;
        },
      });
      auto.classList.add('ins-autologin');
      content.replaceChildren(
        h(
          'div',
          { class: 'ins-form' },
          field('fullname', t('account.fullname'), fullIn),
          field('user', t('account.username'), userIn, t('account.usernameHint')),
          field('password', t('account.password'), h('div', { class: 'ins-pw' }, pwIn, eye)),
          field('confirm', t('account.confirm'), cfIn),
          h('div', { class: 'ins-field ins-span' }, meter),
          field('hostname', t('account.hostname'), hostIn, t('account.hostnameHint')),
          h('div', { class: 'ins-field ins-auto' }, auto, h('span', { class: 'ins-hint' }, t('account.autologinHint'))),
        ),
      );
      refreshAccount = () => {
        const errs = validateAccount(S);
        for (const el of content.querySelectorAll('.ins-field[data-field]')) {
          const k = el.dataset.field;
          const msg = S.touched[k] && errs[k] ? t(errs[k]) : '';
          el.querySelector('.ins-err').textContent = msg;
          el.classList.toggle('invalid', !!msg);
          el.querySelector('input')?.classList.toggle('invalid', !!msg);
          el.querySelector('input')?.setAttribute('aria-invalid', msg ? 'true' : 'false');
        }
        const st = passwordStrength(S.password);
        meter.dataset.level = st || '';
        meter.querySelector('.ins-meter-label').textContent = st ? `${t(`account.strength.${st}`)}${st !== 'strong' ? ` — ${t('account.strength.hint')}` : ''}` : '';
        refreshNext();
      };
      refreshAccount();
      setTimeout(() => (S.fullname ? null : fullIn.focus()), 30);
    }

    let tzCache = null;
    function zoneList() {
      if (!tzCache) {
        const now = new Date();
        tzCache = zones
          .map((z) => zoneInfo(z, now))
          .filter(Boolean)
          .sort((a, b) => a.offset - b.offset || a.city.localeCompare(b.city));
      }
      return tzCache;
    }

    function pageTimezone() {
      setHeader(stepOf('timezone'), t('tz.title'), t('tz.subtitle'));
      const q = S.tzQuery
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
      const fold = (s) =>
        String(s)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '');
      const now = new Date();
      const timeFmt = (id) => {
        try {
          return new Intl.DateTimeFormat(LOCALES[S.lang], { timeZone: id, hour: '2-digit', minute: '2-digit' }).format(now);
        } catch {
          return '';
        }
      };
      const items = zoneList().filter((z) => !q || [z.id, z.city, z.sub, t(`region.${z.region}`), z.offsetLabel].some((s) => fold(s).includes(q)));
      const search = h('input', {
        class: 'input ins-search',
        type: 'search',
        placeholder: t('tz.search'),
        value: S.tzQuery,
        'aria-label': t('tz.search'),
        oninput: (e) => {
          S.tzQuery = e.target.value;
          const pos = e.target.selectionStart;
          pageTimezone();
          const s = content.querySelector('.ins-search');
          s.focus();
          s.setSelectionRange(pos, pos);
        },
      });
      const select = (id, o = {}) => {
        S.timezone = id;
        S.tzTouched = true;
        content.querySelectorAll('.ins-list .ins-row').forEach((r) => {
          const on = r.dataset.id === id;
          r.classList.toggle('selected', on);
          r.setAttribute('aria-selected', on ? 'true' : 'false');
          if (on && o.keyboard) r.scrollIntoView({ block: 'nearest' });
        });
        refreshNext();
      };
      const list = items.length
        ? listbox(items, {
            selected: S.timezone,
            label: t('steps.timezone'),
            cls: 'ins-tz',
            onSelect: select,
            render: (z) => [
              h('span', { class: 'ins-row-offset mono' }, z.offsetLabel),
              h(
                'span',
                { class: 'ins-row-main' },
                h('span', { class: 'ins-row-title' }, z.id === 'UTC' ? 'UTC' : z.city),
                h('span', { class: 'ins-row-sub' }, z.id === 'UTC' ? t('tz.utc') : [t(`region.${z.region}`), z.sub].filter(Boolean).join(' · ')),
              ),
              h('span', { class: 'ins-row-meta' }, timeFmt(z.id)),
              h('span', { class: 'ins-row-check' }, icon('checkmark', { size: 16 })),
            ],
          })
        : h('div', { class: 'ins-empty' }, t('tz.none', { q: S.tzQuery }));
      content.replaceChildren(search, list);
    }

    // ---------------------------------------------------------------- graphics driver (NVIDIA cards only)
    function applyGpu(info) {
      S.gpu = info || { gpus: [], nvidia: [] };
      const cur = STEPS[S.step];
      STEPS = stepsFor(S.gpu, S.mode);
      if (S.phase === 'setup') {
        S.step = Math.max(0, STEPS.indexOf(cur));
        render();
      }
    }
    async function recheckGpu() {
      S.driverChecking = true;
      if (STEPS[S.step] === 'drivers' && S.phase === 'setup') pageDrivers();
      const info = await api.invoke('installer:gpu', { refresh: true }).catch(() => S.gpu);
      S.driverChecking = false;
      // Online now: the switch follows the connection unless it was turned off on purpose.
      if (info?.online && !S.gpu?.online && !S.driverTouched) S.driverWanted = true;
      S.gpu = info || S.gpu;
      if (STEPS[S.step] === 'drivers' && S.phase === 'setup') {
        pageDrivers();
        content.querySelector('[data-act="recheck"]')?.focus();
      }
    }
    const driverLabel = (pkg) => {
      const m = /^nvidia-driver-(\d{3})(-open|-server|-server-open)?$/.exec(pkg || '');
      if (!m) return null;
      const kind = { '-open': 'open', '-server': 'server', '-server-open': 'server-open' }[m[2]] || 'proprietary';
      return t(`drivers.kind.${kind}`, { version: m[1] });
    };
    const driverOn = () => !!(S.gpu?.online && S.driverWanted);

    function pageDrivers() {
      const g = S.gpu || { nvidia: [], gpus: [] };
      setHeader(stepOf('drivers'), t('drivers.title'), t('drivers.subtitle'));
      const cur = g.current || {};
      const curText = cur.module === 'nvidia' ? t('drivers.currentNvidia', { version: cur.version || '' }).trim() : cur.module === 'nouveau' ? t('drivers.currentFree') : t('drivers.currentNone');
      const cards = h(
        'div',
        { class: 'ins-gpu card' },
        g.nvidia.map((c) =>
          h(
            'div',
            { class: 'ins-gpu-row', dataset: { slot: c.slot } },
            h('span', { class: 'ins-row-icon big' }, icon('developer_board', { size: 28 })),
            h('span', { class: 'ins-row-main' }, h('span', { class: 'ins-sum-label' }, t('drivers.card')), h('span', { class: 'ins-row-title' }, c.name), h('span', { class: 'ins-row-sub' }, t('drivers.current', { driver: curText }))),
          ),
        ),
        h(
          'div',
          { class: 'ins-gpu-row ins-gpu-driver' },
          h('span', { class: 'ins-row-icon big' }, icon('arrow_download', { size: 24 })),
          h(
            'span',
            { class: 'ins-row-main' },
            h('span', { class: 'ins-sum-label' }, t('drivers.recommended')),
            h('span', { class: 'ins-row-title' }, g.recommended ? driverLabel(g.recommended) : t('drivers.recommendedAuto')),
            g.recommended ? h('span', { class: 'ins-row-sub mono' }, g.recommended) : null,
          ),
        ),
      );
      const sw = ui.toggle({
        checked: driverOn(),
        disabled: !g.online,
        label: t('drivers.switch'),
        onchange: (v) => {
          S.driverWanted = v;
          S.driverTouched = true;
          pageDrivers();
          content.querySelector('.ins-driver-switch input')?.focus();
        },
      });
      sw.classList.add('ins-driver-switch');
      const others = (g.gpus || []).filter((x) => x.vendor === 'intel' || x.vendor === 'amd');
      const notes = [];
      if (!g.online) {
        notes.push(
          h(
            'div',
            { class: 'infobar warning ins-note ins-offline', role: 'note' },
            icon('wifi_off', { size: 16 }),
            h('div', { class: 'ins-note-body' }, h('div', null, t('drivers.offline')), h('button', { class: 'btn small', 'data-act': 'recheck', disabled: S.driverChecking, onclick: recheckGpu }, S.driverChecking ? t('drivers.checking') : t('drivers.retry'))),
          ),
        );
      } else {
        notes.push(h('span', { class: 'ins-hint ins-driver-hint' }, driverOn() ? t('drivers.onHint') : t('drivers.offHint')));
        if (driverOn() && g.secureBoot === true) notes.push(h('div', { class: 'infobar ins-note ins-secureboot', role: 'note' }, icon('shield_checkmark', { size: 16 }), h('div', null, t('drivers.secureBoot'))));
      }
      if (others.length && g.nvidia.length) notes.push(h('div', { class: 'ins-hint ins-hybrid' }, t('drivers.hybrid', { other: others[0].vendor === 'intel' ? 'Intel' : 'AMD' })));
      content.replaceChildren(cards, h('div', { class: 'ins-driver-toggle' }, sw), ...notes);
    }

    // ---------------------------------------------------------------- games (Flathub apps, installed at the first sign-in)
    const listFmt = (items) => {
      try {
        return new Intl.ListFormat(LOCALES[S.lang], { style: 'long', type: 'conjunction' }).format(items);
      } catch {
        return items.join(', ');
      }
    };
    const gamingNames = (ids, { short = false } = {}) => GAMING_APPS.filter((a) => ids.includes(a.id)).map((a) => (short && a.short) || a.name);
    const gamingOn = () => gamingRequest(S.gamingWanted, S.gamingApps).length > 0;

    function pageGames() {
      setHeader(stepOf('games'), t('games.title'), t('games.subtitle'));
      const on = S.gamingWanted;
      const sw = ui.toggle({
        checked: on,
        label: t('games.switch'),
        onchange: (v) => {
          S.gamingWanted = v;
          pageGames();
          content.querySelector('.ins-games-switch input')?.focus();
        },
      });
      sw.classList.add('ins-games-switch');
      const count = h('span', { class: 'ins-games-count', 'aria-live': 'polite' });
      // One slot under the list: « later from the Store » (off), the Flathub note (on), or « nothing checked ».
      const status = h('div', { class: 'ins-games-status' });
      const refreshStatus = () => {
        const n = gamingRequest(true, S.gamingApps).length;
        count.textContent = on ? t('games.count', { count: n }) : '';
        count.hidden = !on;
        status.replaceChildren(
          !on
            ? h('div', { class: 'ins-games-line ins-games-hint' }, icon('storefront', { size: 16 }), h('span', null, t('games.offHint')))
            : n
              ? h('div', { class: 'ins-games-line ins-games-note', role: 'note' }, icon('cloud-arrow-down', { size: 16 }), h('span', null, t('games.note')))
              : h('div', { class: 'ins-games-line ins-games-none', role: 'note' }, icon('warning', { size: 16 }), h('span', null, t('games.none'))),
        );
      };
      const cards = GAMING_APPS.map((a) => {
        const checked = S.gamingApps.includes(a.id);
        const descId = `ins-game-${win.id}-${a.key}`;
        const input = h('input', {
          type: 'checkbox',
          checked,
          disabled: !on,
          'aria-describedby': descId,
          onchange: (e) => {
            S.gamingApps = e.target.checked ? [...new Set([...S.gamingApps, a.id])] : S.gamingApps.filter((x) => x !== a.id);
            card.classList.toggle('selected', e.target.checked);
            refreshStatus();
          },
        });
        const card = h(
          'label',
          { class: ['ins-game', checked && 'selected'], dataset: { app: a.id } },
          h('span', { class: 'ins-game-icon', 'aria-hidden': 'true' }, icon(a.icon, { size: 20 })),
          h(
            'span',
            { class: 'ins-game-text' },
            h('span', { class: 'ins-game-head' }, h('span', { class: 'ins-game-name' }, a.name), h('span', { class: 'checkbox ins-game-check' }, input)),
            h('span', { class: 'ins-game-desc', id: descId }, t(`games.app.${a.key}.desc`), h('span', { class: 'ins-game-size' }, t(`games.app.${a.key}.size`))),
          ),
        );
        return card;
      });
      const grid = h('div', { class: ['ins-games', !on && 'off'], role: 'group', 'aria-label': t('games.listLabel'), 'aria-disabled': on ? null : 'true' }, cards);
      refreshStatus();
      content.replaceChildren(h('div', { class: 'ins-games-toggle' }, sw, count), grid, status);
    }

    function kbLabel(id) {
      const k = keyboards.find((x) => x.id === id);
      return k ? k.name[S.lang] || k.name.en : id;
    }
    function tzLabel(id) {
      const z = zoneInfo(id);
      if (!z) return id;
      return id === 'UTC' ? `UTC — ${t('tz.utc')}` : `${z.city} (${t(`region.${z.region}`)}) · ${z.offsetLabel}`;
    }
    /** The exact changes of a dual boot, as sentences (summary, confirmation). */
    function changesFor(plan, opt, a) {
      const g = (x) => fmtGiB(x, S.lang);
      if (plan.method === 'reuse') {
        return [t('summary.changeReuse', { size: g(plan.rootMiB) }), t('summary.changeEsp'), t('summary.changeKeep', { os: osName(a) }), t('summary.changeBoot', { os: a?.menuName || osName(a) })];
      }
      return [
        plan.method === 'shrink' ? t('summary.changeShrink', { name: partName(opt), from: g(plan.oldMiB), to: g(plan.newMiB) }) : t('summary.changeFree', { size: g(plan.rootMiB) }),
        plan.method === 'shrink' && opt?.fstype === 'ext4' ? t('summary.changeSlow') : null,
        t('summary.changeNew', { size: g(plan.rootMiB) }),
        t('summary.changeEsp'),
        t('summary.changeKeep', { os: osName(a) }),
        t('summary.changeBoot', { os: a?.menuName || osName(a) }),
      ].filter(Boolean);
    }

    function pageSummary() {
      setHeader(stepOf('summary'), t('summary.title'), t('summary.subtitle'));
      const d = diskObj();
      const row = (ic, label, value, sub, step, opts = {}) =>
        h(
          'div',
          { class: ['ins-sum-row', opts.danger && 'danger'], dataset: { row: opts.key || label } },
          h('span', { class: 'ins-row-icon' }, icon(ic, { size: 20 })),
          h('span', { class: 'ins-row-main' }, h('span', { class: 'ins-sum-label' }, label), h('span', { class: 'ins-row-title' }, value), sub ? h('span', { class: ['ins-row-sub', opts.danger && 'ins-err-text'] }, sub) : null),
          h('button', { class: 'btn subtle small', onclick: () => go(step) }, t('change')),
        );
      const plan = currentPlan();
      const a = analysis();
      const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
      const changes = plan
        ? h(
            'div',
            { class: 'ins-changes card', dataset: { method: plan.method } },
            h('div', { class: 'ins-changes-title' }, icon('hard_drive', { size: 18 }), t('summary.changesTitle', { disk: d?.model || S.disk })),
            h('ul', { class: 'ins-changes-list' }, changesFor(plan, option(), a).map((c) => h('li', null, cap(c)))),
            h('div', { class: 'infobar warning ins-backup', role: 'note' }, icon('save', { size: 16 }), h('div', null, plan.method === 'shrink' ? t('summary.backup') : t('summary.backupFree'))),
            h(
              'label',
              { class: 'ins-backup-check' },
              h(
                'span',
                { class: 'checkbox' },
                h('input', {
                  type: 'checkbox',
                  checked: S.backupOk,
                  'data-act': 'backup',
                  onchange: (e) => {
                    S.backupOk = e.target.checked;
                    refreshNext();
                  },
                }),
              ),
              h('span', null, t('summary.backupCheck')),
            ),
          )
        : null;
      content.replaceChildren(
        ...[changes,
        h(
          'div',
          { class: 'ins-summary card' },
          row('local_language', t('summary.language'), S.lang === 'fr' ? 'Français (France)' : 'English (United States)', null, 0, { key: 'language' }),
          row('keyboard', t('summary.keyboard'), kbLabel(S.keyboard), S.keyboard, 1, { key: 'keyboard' }),
          plan
            ? row('hard_drive', t('summary.disk'), d ? `${d.model || t('disk.unknownModel')} · ${size(d.size)}` : S.disk, `${S.disk} — ${t('summary.alongside', { os: osName(a) })}`, 2, { key: 'disk' })
            : row('hard_drive', t('summary.disk'), d ? `${d.model || t('disk.unknownModel')} · ${size(d.size)}` : S.disk, `${S.disk} — ${t('summary.erase')}`, 2, { danger: true, key: 'disk' }),
          row('person', t('summary.account'), S.fullname.trim(), t('summary.admin', { user: S.user }), STEPS.indexOf('account'), { key: 'account' }),
          row('lock_closed', t('summary.signin'), S.autologin ? t('summary.autologinOn') : t('summary.autologinOff'), null, STEPS.indexOf('account'), { key: 'signin' }),
          row('desktop', t('summary.hostname'), S.hostname, null, STEPS.indexOf('account'), { key: 'hostname' }),
          row('globe_clock', t('summary.timezone'), tzLabel(S.timezone), null, STEPS.indexOf('timezone'), { key: 'timezone' }),
          STEPS.includes('drivers')
            ? row(
                'developer_board',
                t('summary.driver'),
                driverOn() ? (S.gpu?.recommended ? `${t('summary.driverOn')} · ${driverLabel(S.gpu.recommended)}` : t('summary.driverOn')) : t('summary.driverOff'),
                driverOn() ? t('summary.driverOnSub') : t('summary.driverOffSub'),
                STEPS.indexOf('drivers'),
                { key: 'driver' },
              )
            : null,
          STEPS.includes('games')
            ? row(
                'game-controller',
                t('summary.gaming'),
                gamingOn() ? gamingNames(gamingRequest(S.gamingWanted, S.gamingApps), { short: true }).join(', ') : t('summary.gamingOff'),
                gamingOn() ? t('summary.gamingOnSub') : t('summary.gamingOffSub'),
                STEPS.indexOf('games'),
                { key: 'gaming' },
              )
            : null,
        )].filter(Boolean),
      );
    }

    // ---------------------------------------------------------------- installation
    const stageBox = { ring: null, pct: null, label: null, list: null, bar: null, log: null };
    let offProgress = null;

    async function startInstall() {
      const d = diskObj();
      const plan = currentPlan();
      if (S.mode === 'alongside' && (!plan || !S.backupOk)) return;
      const ok = plan
        ? await ui.confirm(t('confirm.alongsideBody', { changes: changesFor(plan, option(), analysis()).map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(' ') }), {
            title: t('confirm.alongsideTitle'),
            okLabel: t('confirm.alongsideOk', { os: osName(analysis()) }),
            cancelLabel: t('cancel'),
            danger: true,
            parent: win,
          })
        : await ui.confirm(t('confirm.body', { disk: `${d?.model || S.disk} (${S.disk})`, size: size(d?.size || 0) }), {
            title: t('confirm.title'),
            okLabel: t('confirm.ok'),
            cancelLabel: t('cancel'),
            danger: true,
            parent: win,
          });
      if (!ok || S.phase !== 'setup') return;
      S.installPlan = plan ? { ...plan, os: osName(analysis()), bitlocker: !!analysis()?.bitlocker } : null;
      S.bootEntry = null;
      S.phase = 'installing';
      S.progress = 0;
      S.stage = null;
      S.stageMessage = '';
      S.log = [];
      S.error = null;
      S.cancelled = false;
      S.cancelling = false;
      S.driverRequested = driverRequest(S.gpu, S.driverWanted);
      S.driverResult = null;
      S.gamingRequested = gamingRequest(S.gamingWanted, S.gamingApps);
      S.gamingResult = null;
      STAGES = S.driverRequested ? [...BASE_STAGES.slice(0, 4), 'drivers', ...BASE_STAGES.slice(4)] : BASE_STAGES.slice();
      render();
      offProgress?.();
      offProgress = api.on('installer:progress', onProgress);
      try {
        const r = await api.invoke('installer:start', {
          disk: S.disk,
          ...(plan ? { mode: 'alongside', alongside: plan.request } : { mode: 'erase' }),
          user: S.user,
          fullname: S.fullname.trim(),
          password: S.password,
          hostname: S.hostname,
          lang: S.lang,
          keyboard: S.keyboard,
          timezone: S.timezone,
          autologin: S.autologin,
          ...(S.driverRequested ? { nvidiaDriver: S.driverRequested } : {}),
          ...(S.gamingRequested.length ? { gaming: S.gamingRequested } : {}),
        });
        S.dryRun = !!r?.dryRun;
      } catch (e) {
        S.phase = 'error';
        S.error = e?.code === 'ENOTADMIN' || e?.code === 'EAUTH' ? { code: e.code, message: e.message } : e?.code === 'EPLAN' ? { code: 'EPLAN', message: e.message } : { message: t('error.start', { error: e.message }) };
        render();
      }
    }

    function onProgress(ev) {
      if (!ev || S.phase !== 'installing') return;
      if (ev.type === 'progress') {
        S.progress = Math.max(S.progress, ev.progress);
        if (ev.stage === 'shrink' && !STAGES.includes('shrink')) {
          // A dual boot that shrinks a partition first: one more stage, at the top of the list.
          STAGES.unshift('shrink');
          if (S.phase === 'installing') pageInstalling();
        }
        if (STAGES.includes(ev.stage)) S.stage = ev.stage;
        if (ev.message) S.stageMessage = ev.message;
        updateProgress();
      } else if (ev.type === 'log') {
        S.log.push(ev.line);
        if (S.log.length > 1500) S.log.splice(0, S.log.length - 1500);
        if (stageBox.log && S.showDetails) {
          stageBox.log.textContent += `${ev.line}\n`;
          if (stageBox.log.textContent.length > 200000) stageBox.log.textContent = stageBox.log.textContent.slice(-150000);
          stageBox.log.scrollTop = stageBox.log.scrollHeight;
        }
      } else if (ev.type === 'driver') {
        S.driverResult = ev; // never an error: reported on the done page
      } else if (ev.type === 'gaming') {
        S.gamingResult = ev; // never an error either (the apps are installed at the first sign-in)
      } else if (ev.type === 'bootentry') {
        S.bootEntry = ev; // dual boot: the firmware entry « Selene » (never an error)
      } else if (ev.type === 'error') {
        S.error = ev;
      } else if (ev.type === 'done') {
        S.progress = 100;
        S.phase = 'done';
        win.setProgress?.(null);
        render();
      } else if (ev.type === 'exit') {
        offProgress?.();
        offProgress = null;
        if (S.phase === 'installing') {
          S.phase = 'error';
          S.cancelled = !!ev.cancelled || /cancelled/i.test(S.error?.message || '');
          win.setProgress?.(null);
          render();
        }
      }
    }

    function updateProgress() {
      const p = Math.round(S.progress);
      if (stageBox.ring) stageBox.ring.style.strokeDashoffset = String(339.29 * (1 - p / 100));
      if (stageBox.pct) stageBox.pct.textContent = `${p}%`;
      if (stageBox.bar) stageBox.bar.style.width = `${p}%`;
      if (stageBox.bar) stageBox.bar.parentElement.setAttribute('aria-valuenow', String(p));
      if (stageBox.label) stageBox.label.textContent = S.cancelling ? t('installing.cancelling') : S.stage ? t(`stage.${S.stage}`) : t('installing.starting');
      const cur = STAGES.indexOf(S.stage);
      stageBox.list?.querySelectorAll('.ins-stage').forEach((li, i) => {
        const st = i < cur ? 'done' : i === cur ? 'active' : 'todo';
        if (li.dataset.state === st) return;
        li.dataset.state = st;
        li.querySelector('.ins-stage-icon').replaceChildren(st === 'done' ? icon('checkmark_circle', { size: 20, filled: true }) : st === 'active' ? h('span', { class: 'spinner small' }) : h('span', { class: 'ins-stage-dot' }));
      });
      win.setProgress?.(p / 100);
    }

    async function confirmCancel() {
      return ui.confirm(t('installing.cancelBody'), {
        title: t('installing.cancelTitle'),
        okLabel: t('installing.cancelOk'),
        cancelLabel: t('installing.continue'),
        danger: true,
        parent: win,
      });
    }

    function pageInstalling() {
      setHeader(null, t('installing.title'), t('installing.subtitle'));
      const ring = h('div', { class: 'ins-ring', role: 'img' });
      ring.innerHTML = `<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ins-ring-track" cx="60" cy="60" r="54"/><circle class="ins-ring-bar" cx="60" cy="60" r="54" stroke-dasharray="339.29" stroke-dashoffset="339.29"/></svg>`;
      stageBox.ring = ring.querySelector('.ins-ring-bar');
      stageBox.pct = h('span', { class: 'ins-ring-pct', 'aria-live': 'off' }, '0%');
      ring.appendChild(stageBox.pct);
      stageBox.label = h('div', { class: 'ins-stage-now', 'aria-live': 'polite' });
      stageBox.list = h(
        'ol',
        { class: 'ins-stages' },
        STAGES.map((s) => h('li', { class: 'ins-stage', dataset: { stage: s, state: '' } }, h('span', { class: 'ins-stage-icon' }), h('span', null, t(`stage.${s}`)))),
      );
      const barWrap = h('div', { class: 'progress ins-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('div', { class: 'bar' }));
      stageBox.bar = barWrap.firstChild;
      stageBox.log = h('pre', { class: 'ins-log selectable', hidden: !S.showDetails, tabindex: 0 });
      stageBox.log.textContent = S.showDetails ? `${S.log.join('\n')}\n` : '';
      const details = h(
        'button',
        {
          class: 'btn subtle small ins-details',
          'aria-expanded': S.showDetails ? 'true' : 'false',
          'data-act': 'details',
          onclick: () => {
            S.showDetails = !S.showDetails;
            stageBox.log.hidden = !S.showDetails;
            details.setAttribute('aria-expanded', S.showDetails ? 'true' : 'false');
            details.lastChild.textContent = S.showDetails ? t('installing.hideDetails') : t('installing.details');
            details.firstChild.replaceWith(icon(S.showDetails ? 'chevron_up' : 'chevron_down', { size: 16 }));
            if (S.showDetails) {
              stageBox.log.textContent = `${S.log.join('\n')}\n`;
              stageBox.log.scrollTop = stageBox.log.scrollHeight;
            }
          },
        },
        icon(S.showDetails ? 'chevron_up' : 'chevron_down', { size: 16 }),
        h('span', null, S.showDetails ? t('installing.hideDetails') : t('installing.details')),
      );
      content.replaceChildren(h('div', { class: 'ins-progress' }, ring, h('div', { class: 'ins-progress-side' }, stageBox.label, stageBox.list)), barWrap, details, stageBox.log);
      footRight.replaceChildren(
        btn(
          S.cancelling ? t('installing.cancelling') : t('cancel'),
          async () => {
            if (S.cancelling || !(await confirmCancel()) || S.phase !== 'installing') return;
            S.cancelling = true;
            updateProgress();
            footRight.querySelector('[data-act="cancel"]').disabled = true;
            await api.invoke('installer:cancel').catch(() => {});
          },
          { id: 'cancel', disabled: S.cancelling },
        ),
      );
      updateProgress();
    }

    function pageDone() {
      setHeader(null, t('done.title'), t('done.subtitle'));
      content.replaceChildren(
        ...[
        S.dryRun ? h('div', { class: 'infobar ins-note' }, icon('info', { size: 16 }), h('div', null, t('done.simulated'))) : null,
        S.driverResult?.status === 'installed'
          ? h('div', { class: 'infobar success ins-note ins-driver-result', dataset: { status: 'installed' } }, icon('checkmark_circle', { size: 16 }), h('div', null, t('done.driverOk', { pkg: S.driverResult.pkg || 'NVIDIA' })))
          : S.driverRequested && S.driverResult?.status !== 'installed'
            ? h('div', { class: 'infobar warning ins-note ins-driver-result', role: 'note', dataset: { status: 'failed' } }, icon('developer_board', { size: 16 }), h('div', null, t('done.driverFailed')))
            : null,
        S.gamingRequested.length
          ? S.gamingResult?.status === 'failed'
            ? h('div', { class: 'infobar warning ins-note ins-gaming-result', role: 'note', dataset: { status: 'failed' } }, icon('game-controller', { size: 16 }), h('div', null, t('done.gamingFailed')))
            : h('div', { class: 'infobar ins-note ins-gaming-result', dataset: { status: 'saved' } }, icon('game-controller', { size: 16 }), h('div', null, t('done.gaming', { apps: listFmt(gamingNames(S.gamingRequested, { short: true })) })))
          : null,
        S.installPlan ? h('div', { class: 'infobar success ins-note ins-dualboot' }, icon('split_vertical', { size: 16 }), h('div', null, t('done.dualboot', { os: S.installPlan.os }))) : null,
        S.installPlan && S.bootEntry?.status === 'failed' ? h('div', { class: 'infobar warning ins-note ins-bootentry', role: 'note' }, icon('power', { size: 16 }), h('div', null, t('done.bootentryFailed'))) : null,
        S.installPlan?.bitlocker ? h('div', { class: 'infobar ins-note ins-bitlocker-done' }, icon('shield_keyhole', { size: 16 }), h('div', null, t('done.bitlocker'))) : null,
        h('div', { class: 'infobar warning ins-note' }, icon('usb_stick', { size: 16 }), h('div', null, t('done.removeMedia'))),
        h('p', { class: 'ins-done-account' }, t('done.account', { name: S.fullname.trim(), user: S.user })),
        h('div', { class: 'ins-done-msg', role: 'status', 'aria-live': 'polite' }),
        ].filter(Boolean),
      );
      footRight.replaceChildren(
        btn(t('done.later'), () => win.close(), { id: 'later' }),
        btn(
          t('done.restart'),
          async () => {
            const msg = content.querySelector('.ins-done-msg');
            try {
              const r = await api.invoke('installer:reboot');
              if (r?.simulated) msg.textContent = t('done.restartSimulated');
            } catch (e) {
              msg.textContent = t('done.restartFailed', { error: e.message });
            }
          },
          { primary: true, id: 'restart' },
        ),
      );
    }

    function pageError() {
      const cancelled = S.cancelled;
      setHeader(null, cancelled ? t('error.cancelledTitle') : t('error.title'), S.installPlan ? t('error.subtitleAlongside', { os: S.installPlan.os }) : cancelled ? t('error.cancelledSubtitle') : t('error.subtitle'));
      const raw = String(S.error?.message || '');
      // sudo refused: a standard account (ENOTADMIN) or one that needs a password (EAUTH).
      const planRefused = S.error?.code === 'EPLAN' || (S.installPlan && Number(S.error?.code) === 4 && /changed since/i.test(raw));
      const msg = S.error?.code === 'ENOTADMIN' ? t('error.notAdmin') : S.error?.code === 'EAUTH' ? t('error.auth') : planRefused ? t('error.plan') : raw;
      const excerpt = S.log.slice(-40).join('\n');
      content.replaceChildren(
        ...[
        msg && !cancelled ? h('div', { class: 'infobar error ins-note', role: 'alert' }, icon('error_circle', { size: 16 }), h('div', null, h('div', { class: 'body-strong' }, t('error.details')), h('div', { class: 'selectable ins-error-msg' }, msg))) : null,
        excerpt ? h('div', { class: 'ins-label' }, t('error.log')) : null,
        excerpt ? h('pre', { class: 'ins-log selectable ins-log-excerpt', tabindex: 0 }, excerpt) : null,
        S.dryRun ? null : h('div', { class: 'ins-hint' }, t('error.logFile')),
        ].filter(Boolean),
      );
      setTimeout(() => {
        const pre = content.querySelector('.ins-log-excerpt');
        if (pre) pre.scrollTop = pre.scrollHeight;
      }, 0);
      footRight.replaceChildren(
        btn(t('close'), () => win.close(), { id: 'close' }),
        btn(
          t('error.retry'),
          () => {
            S.phase = 'setup';
            if (planRefused) {
              // The disk changed: back to the disk step with a fresh analysis (the plan is chosen again).
              S.mode = null;
              S.backupOk = false;
              STEPS = stepsFor(S.gpu, null);
              S.step = STEPS.indexOf('disk');
              S.disks = null;
            } else S.step = STEPS.indexOf('summary');
            render();
          },
          { primary: true, id: 'retry' },
        ),
      );
    }

    // ---------------------------------------------------------------- render
    let lastKey = '';
    function render() {
      const name = S.phase === 'setup' ? STEPS[S.step] : S.phase;
      root.dataset.step = S.phase === 'setup' ? STEPS[S.step] : '';
      root.dataset.phase = S.phase;
      root.lang = S.lang;
      const key = `${name}`;
      const artName = { welcome: 'welcome', keyboard: 'keyboard', disk: 'disk', space: 'disk', account: 'account', timezone: 'timezone', drivers: 'drivers', games: 'games', summary: 'summary', installing: 'installing', done: 'done', error: 'error' }[name];
      renderChrome(artName);
      refreshAccount = null;
      if (S.phase === 'setup') {
        ({ welcome: pageWelcome, keyboard: pageKeyboard, disk: pageDisk, space: pageSpace, account: pageAccount, timezone: pageTimezone, drivers: pageDrivers, games: pageGames, summary: pageSummary })[name]();
        setupFooter();
        if (name === 'disk' && S.disks == null) loadDisks();
      } else if (S.phase === 'installing') pageInstalling();
      else if (S.phase === 'done') pageDone();
      else pageError();
      if (key !== lastKey) {
        lastKey = key;
        page.classList.remove('enter');
        void page.offsetWidth;
        page.classList.add('enter');
        content.scrollTop = 0;
      }
    }

    // Enter = Next (except in multi-line fields and on buttons, which handle Enter themselves).
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
      const tag = e.target.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA' || e.target.closest('.dialog-layer')) return;
      if (S.phase !== 'setup') return;
      if (e.target.closest('.ins-test')) return; // keyboard test field
      e.preventDefault();
      next();
    });

    win.onBeforeClose(async () => {
      if (S.phase !== 'installing') return true;
      if (!(await confirmCancel())) return false;
      await api.invoke('installer:cancel').catch(() => {});
      return true;
    });
    ctx.onClose(() => offProgress?.());

    // Test/automation hook (read-only view of the state + a few actions).
    window.__installer = {
      get state() {
        return { ...S, password: S.password ? '***' : '', confirm: S.confirm ? '***' : '' };
      },
      get steps() {
        return STEPS.slice();
      },
      get stages() {
        return STAGES.slice();
      },
      next,
      back,
      go,
    };

    render();
    // Graphics card probe (lspci, ubuntu-drivers, connection): adds the graphics driver step for an NVIDIA card.
    api
      .invoke('installer:gpu')
      .then(applyGpu)
      .catch(() => applyGpu(null));
    return {
      onRelaunch() {
        win.focus();
      },
    };
  },
};
