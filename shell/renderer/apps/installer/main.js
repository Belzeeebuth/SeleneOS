// Install Selene OS: the installer of the live session (Nocturne look: a night side panel with the steps
// drawn as moon phases, flat pages on the right).
//
// Steps: welcome (language) -> keyboard -> disk -> account -> time zone -> [graphics driver] -> games -> summary
// -> installing -> done | error. The graphics driver step only exists when an NVIDIA card is detected (installer:gpu):
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
/** Steps of the installer: the graphics driver step only for a computer with an NVIDIA card, then the games step. */
export function stepsFor(gpu) {
  return gpu?.nvidia?.length ? [...BASE_STEPS.slice(0, -2), 'drivers', 'games', 'summary'] : BASE_STEPS.slice();
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
        case 'disk':
          return !!S.disk && !!S.disks?.find((d) => d.path === S.disk && !d.tooSmall);
        case 'account':
          return Object.keys(validateAccount(S)).length === 0;
        case 'timezone':
          return !!S.timezone;
        default:
          return true;
      }
    };
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
          S.disk = id;
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
                  h('span', { class: ['ins-row-sub', d.tooSmall && 'ins-err-text'] }, d.tooSmall ? t('disk.tooSmall', { size: size(status.minSize || 12e9) }) : parts),
                ),
                h('span', { class: 'ins-row-size' }, size(d.size)),
                h('span', { class: 'ins-row-check' }, icon('checkmark', { size: 16 })),
              ];
            },
          },
        );
      }
      content.replaceChildren(
        h('div', { class: 'ins-toolbar' }, refresh),
        body,
        h('div', { class: 'infobar warning ins-warning', role: 'note' }, icon('warning', { size: 16 }), h('div', null, t('disk.warning'))),
      );
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
      STEPS = stepsFor(S.gpu);
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
    const diskObj = () => S.disks?.find((d) => d.path === S.disk);

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
      content.replaceChildren(
        h(
          'div',
          { class: 'ins-summary card' },
          row('local_language', t('summary.language'), S.lang === 'fr' ? 'Français (France)' : 'English (United States)', null, 0, { key: 'language' }),
          row('keyboard', t('summary.keyboard'), kbLabel(S.keyboard), S.keyboard, 1, { key: 'keyboard' }),
          row('hard_drive', t('summary.disk'), d ? `${d.model || t('disk.unknownModel')} · ${size(d.size)}` : S.disk, `${S.disk} — ${t('summary.erase')}`, 2, { danger: true, key: 'disk' }),
          row('person', t('summary.account'), S.fullname.trim(), t('summary.admin', { user: S.user }), 3, { key: 'account' }),
          row('lock_closed', t('summary.signin'), S.autologin ? t('summary.autologinOn') : t('summary.autologinOff'), null, 3, { key: 'signin' }),
          row('desktop', t('summary.hostname'), S.hostname, null, 3, { key: 'hostname' }),
          row('globe_clock', t('summary.timezone'), tzLabel(S.timezone), null, 4, { key: 'timezone' }),
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
        ),
      );
    }

    // ---------------------------------------------------------------- installation
    const stageBox = { ring: null, pct: null, label: null, list: null, bar: null, log: null };
    let offProgress = null;

    async function startInstall() {
      const d = diskObj();
      const ok = await ui.confirm(t('confirm.body', { disk: `${d?.model || S.disk} (${S.disk})`, size: size(d?.size || 0) }), {
        title: t('confirm.title'),
        okLabel: t('confirm.ok'),
        cancelLabel: t('cancel'),
        danger: true,
        parent: win,
      });
      if (!ok || S.phase !== 'setup') return;
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
        S.error = e?.code === 'ENOTADMIN' || e?.code === 'EAUTH' ? { code: e.code, message: e.message } : { message: t('error.start', { error: e.message }) };
        render();
      }
    }

    function onProgress(ev) {
      if (!ev || S.phase !== 'installing') return;
      if (ev.type === 'progress') {
        S.progress = Math.max(S.progress, ev.progress);
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
      setHeader(null, cancelled ? t('error.cancelledTitle') : t('error.title'), cancelled ? t('error.cancelledSubtitle') : t('error.subtitle'));
      const raw = String(S.error?.message || '');
      // sudo refused: a standard account (ENOTADMIN) or one that needs a password (EAUTH).
      const msg = S.error?.code === 'ENOTADMIN' ? t('error.notAdmin') : S.error?.code === 'EAUTH' ? t('error.auth') : raw;
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
            S.step = STEPS.indexOf('summary');
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
      const artName = { welcome: 'welcome', keyboard: 'keyboard', disk: 'disk', account: 'account', timezone: 'timezone', drivers: 'drivers', games: 'games', summary: 'summary', installing: 'installing', done: 'done', error: 'error' }[name];
      renderChrome(artName);
      refreshAccount = null;
      if (S.phase === 'setup') {
        ({ welcome: pageWelcome, keyboard: pageKeyboard, disk: pageDisk, account: pageAccount, timezone: pageTimezone, drivers: pageDrivers, games: pageGames, summary: pageSummary })[name]();
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
