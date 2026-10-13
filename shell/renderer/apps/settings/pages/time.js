// Settings > Time & language: Date & time, Language & region, Keyboard.
import { PAGES } from '../lib/index.js';

export const LAYOUTS = [
  ['us', 'English (United States)', 'Anglais (États-Unis)'],
  ['us(intl)', 'English (US, international with dead keys)', 'Anglais (États-Unis, international avec touches mortes)'],
  ['gb', 'English (United Kingdom)', 'Anglais (Royaume-Uni)'],
  ['fr', 'French (AZERTY)', 'Français (AZERTY)'],
  ['fr(oss)', 'French (alternative)', 'Français (variante)'],
  ['fr(bepo)', 'French (BÉPO, ergonomic)', 'Français (BÉPO, ergonomique)'],
  ['be', 'Belgian', 'Belge'],
  ['ch(fr)', 'French (Switzerland)', 'Français (Suisse)'],
  ['ca', 'French (Canada)', 'Français (Canada)'],
  ['ca(multix)', 'Canadian multilingual', 'Canadien multilingue'],
  ['ch', 'German (Switzerland)', 'Allemand (Suisse)'],
  ['de', 'German', 'Allemand'],
  ['es', 'Spanish', 'Espagnol'],
  ['latam', 'Spanish (Latin American)', 'Espagnol (Amérique latine)'],
  ['it', 'Italian', 'Italien'],
  ['pt', 'Portuguese', 'Portugais'],
  ['br', 'Portuguese (Brazil)', 'Portugais (Brésil)'],
  ['nl', 'Dutch', 'Néerlandais'],
  ['se', 'Swedish', 'Suédois'],
  ['no', 'Norwegian', 'Norvégien'],
  ['dk', 'Danish', 'Danois'],
  ['fi', 'Finnish', 'Finnois'],
  ['pl', 'Polish', 'Polonais'],
  ['ru', 'Russian', 'Russe'],
];
export const LOCALES = [
  ['en_US.UTF-8', 'English (United States)', 'Anglais (États-Unis)'],
  ['en_GB.UTF-8', 'English (United Kingdom)', 'Anglais (Royaume-Uni)'],
  ['fr_FR.UTF-8', 'Français (France)', 'Français (France)'],
  ['fr_BE.UTF-8', 'Français (Belgique)', 'Français (Belgique)'],
  ['fr_CA.UTF-8', 'Français (Canada)', 'Français (Canada)'],
  ['fr_CH.UTF-8', 'Français (Suisse)', 'Français (Suisse)'],
];

/** "+01:00" offset of a zone right now (from Intl), or '' */
export function tzOffset(tz, at = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || '';
    if (part === 'GMT') return '+00:00';
    const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(part);
    return m ? `${m[1]}:${m[2] || '00'}` : '';
  } catch {
    return '';
  }
}
const offsetMinutes = (o) => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(o);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};
export function tzLabel(tz, offsets = new Map()) {
  const o = offsets.get(tz) ?? tzOffset(tz);
  const parts = String(tz).split('/');
  const city = parts[parts.length - 1].replace(/_/g, ' ');
  const region = parts.length > 1 ? parts.slice(0, -1).join('/').replace(/_/g, ' ') : '';
  return `(UTC${o}) ${city}${region ? ` — ${region}` : ''}`;
}

function layoutName(pc, v) {
  const l = LAYOUTS.find((x) => x[0] === v);
  return l ? (pc.lang === 'fr' ? l[2] : l[1]) : v;
}

// ------------------------------------------------------------------ Time & language home
async function timeLanguage(pc) {
  const { h, kit, L, i18n, settings } = pc;
  const st = await pc.tryInvoke('locale:status');
  const clock = h('div', { class: 'st-clock-big' });
  const date = h('div', { class: 'st-hero-sub' });
  const tick = () => {
    const now = new Date();
    clock.textContent = i18n.formatTime(now, { hour: 'numeric', minute: '2-digit', hour12: hour12(settings) });
    date.textContent = `${i18n.formatDate(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${st?.timezone ? ` · ${st.timezone.replace(/_/g, ' ')}` : ''}`;
  };
  tick();
  pc.every(1000, tick);
  return h('div', null, h('div', { class: 'st-clock-hero' }, clock, date), kit.group(null, ...['time', 'language', 'keyboard'].map((id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) }))));
}

function hour12(settings) {
  const v = settings.get('clock24h');
  return v == null ? undefined : !v;
}

// ------------------------------------------------------------------ Date & time
async function time(pc) {
  const { h, t, kit, settings, i18n } = pc;
  let st = await pc.tryInvoke('locale:status');
  const adm = await pc.adminStatus();
  const clock = h('div', { class: 'st-clock-big' });
  const date = h('div', { class: 'st-hero-sub' });
  const tick = () => {
    const now = new Date();
    clock.textContent = i18n.formatTime(now, { hour: 'numeric', minute: '2-digit', second: settings.get('showSeconds') ? '2-digit' : undefined, hour12: hour12(settings) });
    date.textContent = i18n.formatDate(now, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  tick();
  pc.every(1000, tick);

  const zones = (await pc.tryInvoke('locale:timezones')) || (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []);
  const now = new Date();
  const offsets = new Map(zones.map((z) => [z, tzOffset(z, now)]));
  const sorted = [...zones].sort((a, b) => offsetMinutes(offsets.get(a)) - offsetMinutes(offsets.get(b)) || a.localeCompare(b));
  const tzPicker = kit.picker({
    items: sorted,
    value: st?.timezone || null,
    width: 300,
    label: t('time.timezone'),
    placeholder: t('time.unknownZone'),
    format: (z) => tzLabel(z, offsets),
    onChange: async (z) => {
      await pc.runAdmin('set-timezone', [z], 'time.reasonTimezone', { zone: z });
      st = (await pc.tryInvoke('locale:status')) || st;
      pc.toast(t('time.zoneChanged', { zone: tzLabel(z, offsets) }));
    },
  });
  const ntp = kit.toggle({
    value: !!st?.ntp,
    label: t('time.auto'),
    disabled: st?.canNtp === false,
    onChange: (v) => pc.runAdmin('set-ntp', [v ? '1' : '0'], v ? 'time.reasonNtpOn' : 'time.reasonNtpOff'),
  });
  const effective24 = () => {
    const v = settings.get('clock24h');
    if (v != null) return !!v;
    return !new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric' }).resolvedOptions().hour12;
  };
  const t24 = kit.toggle({ value: effective24(), label: t('time.clock24h'), onChange: (v) => settings.set('clock24h', v) });
  pc.onDispose(settings.on('clock24h', () => t24.set(effective24())));
  return h(
    'div',
    null,
    h('div', { class: 'st-clock-hero' }, clock, date),
    kit.group(
      null,
      kit.row({
        icon: 'arrow_sync',
        title: t('time.auto'),
        desc: st?.ntp == null ? t('time.autoUnknown') : st?.ntp ? (st.ntpSynced ? t('time.synced') : t('time.notSynced')) : t('time.autoDesc'),
        section: 'ntp',
        control: ntp,
      }),
      kit.row({ icon: 'globe_clock', title: t('time.timezone'), desc: t('time.timezoneDesc'), section: 'timezone', control: tzPicker }),
    ),
    kit.group(
      t('time.taskbarClock'),
      kit.row({ icon: 'clock', title: t('time.clock24h'), desc: t('time.clock24hDesc'), section: 'clock24h', control: t24 }),
      kit.settingToggleRow({ icon: 'timer', title: t('time.seconds'), desc: t('time.secondsDesc'), key: 'showSeconds', def: false, section: 'seconds' }),
    ),
    adm?.simulated ? kit.infobar({ kind: 'info', message: t('settings.simulated') }) : null,
  );
}

// ------------------------------------------------------------------ Language & region
async function language(pc) {
  const { h, t, kit, settings, i18n } = pc;
  const st = await pc.tryInvoke('locale:status');
  const cur = settings.get('lang') || i18n.lang;
  const langCombo = kit.combo({
    options: [
      { value: 'en', label: 'English (United States)' },
      { value: 'fr', label: 'Français (France)' },
    ],
    value: cur,
    width: 240,
    label: t('lang.display'),
    onChange: (v) => settings.set('lang', v),
  });
  const sysLoc = st?.locale && LOCALES.some((l) => l[0] === st.locale) ? st.locale : null;
  const locCombo = kit.combo({
    options: LOCALES.map(([v, en, fr]) => ({ value: v, label: pc.lang === 'fr' ? fr : en })),
    value: sysLoc || 'en_US.UTF-8',
    width: 240,
    label: t('lang.system'),
    onChange: async (v) => {
      await pc.runAdmin('set-locale', [v], 'lang.reasonLocale', { locale: v });
      pc.toast(t('lang.localeChanged'));
    },
  });
  const now = new Date(2026, 8, 24, 16, 35);
  const fmt = [
    [t('lang.shortDate'), i18n.formatDate(now, { dateStyle: 'short' })],
    [t('lang.longDate'), i18n.formatDate(now, { dateStyle: 'full' })],
    [t('lang.shortTime'), i18n.formatTime(now, { hour: 'numeric', minute: '2-digit', hour12: hour12(settings) })],
    [t('lang.number'), i18n.formatNumber(1234567.89)],
    [t('lang.currency'), i18n.formatNumber(1234.5, { style: 'currency', currency: pc.lang === 'fr' ? 'EUR' : 'USD' })],
  ];
  return h(
    'div',
    null,
    kit.group(
      t('lang.language'),
      kit.row({ icon: 'local_language', title: t('lang.display'), desc: t('lang.displayDesc'), section: 'display', control: langCombo }),
      kit.row({ icon: 'globe', title: t('lang.system'), desc: st?.locale ? t('lang.systemDesc', { locale: st.locale }) : t('lang.systemDescNone'), section: 'system', control: locCombo }),
    ),
    kit.group(
      t('lang.region'),
      kit.expander({
        icon: 'calendar_ltr',
        title: t('lang.format'),
        desc: t('lang.formatDesc', { name: pc.lang === 'fr' ? 'Français (France)' : 'English (United States)' }),
        open: true,
        body: () => h('div', { class: 'st-kv st-sub-pad' }, fmt.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])),
      }),
    ),
    // Spell check (core/features/spell.js + main/ipc/spell.js); on by default.
    kit.group(
      t('lang.spelling'),
      kit.row({
        icon: 'text_t',
        title: t('lang.spellcheck'),
        desc: t('lang.spellcheckDesc'),
        section: 'spellcheck',
        control: kit.toggle({ value: settings.get('spellcheck') !== false, label: t('lang.spellcheck'), onChange: (v) => settings.set('spellcheck', !!v) }),
      }),
    ),
    kit.related([{ icon: 'keyboard', title: pc.pageTitle('keyboard'), desc: pc.L(PAGES.keyboard.desc), onClick: () => pc.go('keyboard') }]),
  );
}

// ------------------------------------------------------------------ Keyboard
async function keyboard(pc) {
  const { h, t, kit, api } = pc;
  const st = await pc.tryInvoke('locale:status');
  let session = st?.keyboard || 'us';
  const items = LAYOUTS.map((l) => l[0]);
  if (!items.includes(session)) items.unshift(session);
  const sys = st?.systemKeyboard ? (st.systemKeyboard.variant ? `${st.systemKeyboard.layout}(${st.systemKeyboard.variant})` : st.systemKeyboard.layout) : null;
  const sysDesc = h('span', null, sys ? t('kbd.systemCurrent', { name: layoutName(pc, sys) }) : t('kbd.systemDesc'));
  const applyBtn = kit.button(t('kbd.applySystem'), async (e) => {
    const [, layout, variant] = /^([a-z]+)(?:\(([^)]+)\))?$/.exec(session) || [];
    if (!layout) return;
    await kit.busy(e.currentTarget, async () => {
      try {
        await pc.runAdmin('set-keyboard', variant ? [layout, variant] : [layout], 'kbd.reasonSystem', { name: layoutName(pc, session) });
        sysDesc.textContent = t('kbd.systemCurrent', { name: layoutName(pc, session) });
        pc.toast(t('kbd.systemDone'));
      } catch (err) {
        pc.toastError(err);
      }
    });
  });
  const picker = kit.picker({
    items,
    value: session,
    width: 300,
    label: t('kbd.layout'),
    format: (v) => layoutName(pc, v),
    onChange: async (v) => {
      session = await api.invoke('locale:setKeyboard', v);
      test.focus();
    },
  });
  const test = h('input', { class: 'input st-type-test', placeholder: t('kbd.testPlaceholder'), 'aria-label': t('kbd.test'), spellcheck: false });
  return h(
    'div',
    null,
    kit.group(
      null,
      kit.row({ icon: 'keyboard', title: t('kbd.layout'), desc: t('kbd.layoutDesc'), control: picker }),
      kit.row({ icon: 'person_key', title: t('kbd.system'), desc: sysDesc, control: applyBtn }),
      kit.row({ icon: 'text_font', title: t('kbd.test'), desc: t('kbd.testDesc'), control: test }),
    ),
  );
}

export default { timeLanguage, time, language, keyboard };
