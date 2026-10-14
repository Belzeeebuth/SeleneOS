// Disks: drives and partitions (main/ipc/disks.js), mount / unmount / eject, format removable drives through the
// elevation prompt (aurora-admin format-removable), and « Santé du disque » (health.js: SMART status, self-tests).
// Launch args: { device: '/dev/sda', view: 'health' } (the health notification opens the drive's health view).
// Test hook: the window element carries __disks { state, load, health }.
import { createHealth } from './health.js';

const MiB = 1024 * 1024;
const LABEL_MAX = { vfat: 11, exfat: 15, ext4: 16 };

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell, i18n } = ctx;
    const state = {
      drives: [], sel: null, part: null, loading: true, error: '', simulated: false, busy: '', note: null,
      // health view (health.js)
      view: 'volumes', health: {}, healthFresh: {}, healthLoading: '', healthError: '', healthNote: null, isAdmin: null, pollMs: 10000, expertOpen: false,
    };
    const args = ctx.args || {};
    const lang = () => (i18n?.lang || 'en').slice(0, 2);
    const nf = (n, d) => new Intl.NumberFormat(lang(), { maximumFractionDigits: d }).format(n);
    const unitsEn = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unitsFr = ['o', 'Ko', 'Mo', 'Go', 'To'];
    function size(bytes) {
      if (bytes == null || !Number.isFinite(bytes)) return t('none');
      const u = lang() === 'fr' ? unitsFr : unitsEn;
      let i = 0;
      let v = bytes;
      while (v >= 1000 && i < u.length - 1) {
        v /= 1000;
        i++;
      }
      return `${nf(v, v < 10 && i > 0 ? 1 : v < 100 && i > 0 ? 1 : 0)} ${u[i]}`;
    }
    const driveName = (d) => d.model || t('unnamed', { name: d.name });
    const partName = (p) => p.label || p.partlabel || p.name;
    const tranLabel = (d) => ({ usb: 'USB', nvme: 'NVMe', sata: 'SATA', ata: 'ATA', sas: 'SAS', scsi: 'SCSI', mmc: 'SD / MMC', virtio: 'VirtIO', iscsi: 'iSCSI' }[d.tran] || d.tran.toUpperCase() || t('none'));
    const driveIcon = (d) => (d.type === 'rom' ? 'storage' : d.tran === 'usb' ? 'usb_stick' : d.removable ? 'port_usb_a' : 'hard_drive');
    const fsLabel = (p) => (p.swap || p.fstype === 'swap' ? t('swap') : p.fstype ? (p.fstype === 'vfat' ? p.fsver || 'FAT' : p.fstype) : t('unknownFs'));
    const selDrive = () => state.drives.find((d) => d.path === state.sel) || null;
    const volumes = (d) => (d ? (d.fs ? [d.fs] : d.partitions) : []);
    const selPart = () => volumes(selDrive()).find((p) => p.path === state.part) || null;

    // ------------------------------------------------------------ layout
    const listEl = h('div', { class: 'dk-list', role: 'listbox', 'aria-label': t('drives'), tabindex: '-1' });
    const refreshBtn = h('button', { class: 'btn subtle dk-refresh', title: t('refresh'), 'aria-label': t('refresh'), onclick: () => load() }, icon('arrow_sync'));
    const simNote = h('div', { class: 'dk-sim caption text-2', hidden: true }, t('simulated'));
    const side = h('aside', { class: 'dk-side' }, h('div', { class: 'dk-side-head' }, h('div', { class: 'subtitle' }, t('drives')), refreshBtn), listEl, simNote);
    const mainEl = h('main', { class: 'dk-main', tabindex: '-1' });
    const root = h('div', { class: 'disks' }, side, mainEl);
    win.body.appendChild(root);
    const hv = createHealth({ ctx, state, renderList, renderMain, size, nf, lang, driveName });
    win.el && (win.el.__disks = { state, load: () => load(), health: hv });
    ctx.onClose?.(() => hv.dispose());

    // ------------------------------------------------------------ data
    let seq = 0;
    let firstLoad = true;
    async function load({ quiet = false } = {}) {
      const my = ++seq;
      if (!quiet && !state.drives.length) {
        state.loading = true;
        render();
      }
      try {
        const res = await api.invoke('disks:list');
        if (win.closed || my !== seq) return;
        state.drives = Array.isArray(res?.drives) ? res.drives : [];
        state.simulated = !!res?.simulated;
        state.error = '';
      } catch (e) {
        if (win.closed || my !== seq) return;
        state.error = t('loadFailed', { msg: e?.message || String(e) });
      }
      state.loading = false;
      if (firstLoad && args.device && state.drives.some((d) => d.path === args.device)) {
        state.sel = args.device;
        if (args.view === 'health') state.view = 'health';
      }
      if (!selDrive()) state.sel = (state.drives.find((d) => d.removable) || state.drives[0])?.path || null;
      if (!selPart()) state.part = volumes(selDrive())[0]?.path || null;
      // Health of every drive (udisks' cached data, nothing is woken up): the list markers, the « Health (SMART) » row,
      // and the once-only « Attention » notification (disks:healthCheck). The first time, wait for it briefly.
      const unknown = state.drives.some((d) => !state.health[d.path]);
      if (firstLoad) {
        firstLoad = false;
        await Promise.race([hv.check(), new Promise((r) => setTimeout(r, 1500))]);
        if (win.closed || my !== seq) return;
      } else if (unknown) hv.check().then(() => !win.closed && render());
      render();
    }
    const offChanged = api.on('disks:changed', () => load({ quiet: true }));
    ctx.onClose?.(() => offChanged?.());
    api.invoke('disks:watch').catch(() => {});

    // ------------------------------------------------------------ render
    function render() {
      renderList();
      renderMain();
    }

    function renderList() {
      simNote.hidden = !state.simulated;
      const items = state.drives.map((d) => {
        const sel = d.path === state.sel;
        return h(
          'div',
          {
            class: ['dk-drive', sel && 'selected'],
            role: 'option',
            'aria-selected': sel ? 'true' : 'false',
            tabindex: sel ? '0' : '-1',
            'data-path': d.path,
            onclick: () => selectDrive(d.path, true),
          },
          h('span', { class: 'dk-drive-icon' }, icon(driveIcon(d), { size: 24 })),
          h(
            'span',
            { class: 'dk-drive-text' },
            h('span', { class: 'dk-drive-name' }, driveName(d)),
            h('span', { class: 'caption text-2' }, [size(d.size), tranLabel(d), d.system ? t('systemDisk') : d.removable ? t('removableDisk') : ''].filter(Boolean).join(' · ')),
          ),
          hv.listBadge(d),
        );
      });
      if (!items.length) items.push(h('div', { class: 'caption text-2 dk-list-empty' }, state.loading ? t('loading') : t('noDrives')));
      listEl.replaceChildren(...items);
    }

    function selectDrive(path, focus) {
      if (state.sel !== path) {
        state.sel = path;
        state.part = volumes(selDrive())[0]?.path || null;
        state.note = null;
        state.healthNote = null;
      }
      render();
      if (focus) listEl.querySelector('.dk-drive.selected')?.focus();
    }

    listEl.addEventListener('keydown', (e) => {
      const i = state.drives.findIndex((d) => d.path === state.sel);
      let n = i;
      if (e.key === 'ArrowDown') n = Math.min(state.drives.length - 1, i + 1);
      else if (e.key === 'ArrowUp') n = Math.max(0, i - 1);
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = state.drives.length - 1;
      else return;
      e.preventDefault();
      if (state.drives[n]) selectDrive(state.drives[n].path, true);
    });

    function row(label, value, cls) {
      return h('div', { class: ['dk-row', cls] }, h('div', { class: 'dk-row-k text-2' }, label), h('div', { class: 'dk-row-v selectable' }, value ?? t('none')));
    }

    function note() {
      if (!state.note) return '';
      const n = state.note;
      const ic = { success: 'checkmark_circle', error: 'error_circle', warning: 'warning', info: 'info' }[n.kind] || 'info';
      return h('div', { class: ['infobar', 'dk-note', n.kind], role: n.kind === 'error' ? 'alert' : 'status' }, icon(ic), h('div', { class: 'dk-note-text' }, n.text));
    }

    function partitionBar(d) {
      const vols = volumes(d);
      const segs = [];
      let cursor = MiB;
      const sorted = [...vols].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      const gap = (from, to) => {
        const len = to - from;
        if (len > Math.max(16 * MiB, d.size * 0.005)) segs.push({ free: true, size: len });
      };
      for (const p of sorted) {
        if (p.start != null && !d.fs) gap(cursor, p.start);
        segs.push({ part: p, size: p.size });
        if (p.start != null) cursor = p.start + p.size;
      }
      if (!d.fs && sorted.every((p) => p.start != null)) gap(cursor, d.size);
      if (!segs.length) segs.push({ free: true, size: d.size, empty: true });
      const els = segs.map((s) => {
        const style = { flexGrow: String(Math.max(s.size, 1) / Math.max(d.size, 1)) };
        if (s.free) {
          return h('div', { class: 'dk-seg free', style, title: `${s.empty ? t('noPartitions') : t('freeSpace')} · ${size(s.size)}` },
            h('span', { class: 'dk-seg-name' }, s.empty ? t('noPartitions') : t('freeSpace')), h('span', { class: 'dk-seg-size caption' }, size(s.size)));
        }
        const p = s.part;
        const sel = p.path === state.part;
        const usedFrac = p.used != null && (p.fssize || p.size) ? Math.min(1, p.used / (p.fssize || p.size)) : 0;
        return h(
          'button',
          {
            class: ['dk-seg', sel && 'selected', p.swap && 'swap', p.system && 'system', p.mountpoints?.length && 'mounted'],
            style,
            role: 'radio',
            'aria-checked': sel ? 'true' : 'false',
            tabindex: sel ? '0' : '-1',
            'data-path': p.path,
            title: `${partName(p)} · ${fsLabel(p)} · ${size(p.size)}`,
            onclick: () => {
              state.part = p.path;
              renderMain();
              mainEl.querySelector('.dk-seg.selected')?.focus();
            },
          },
          h('span', { class: 'dk-seg-used', style: { transform: `scaleX(${usedFrac})` } }),
          h('span', { class: 'dk-seg-name' }, partName(p)),
          h('span', { class: 'dk-seg-size caption' }, `${size(p.size)} ${fsLabel(p)}`),
        );
      });
      const bar = h('div', { class: 'dk-bar', role: 'radiogroup', 'aria-label': t('partitionBar', { name: driveName(d) }) }, els);
      bar.addEventListener('keydown', (e) => {
        const btns = [...bar.querySelectorAll('button.dk-seg')];
        const i = btns.indexOf(document.activeElement);
        let n = i;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = Math.min(btns.length - 1, i + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = Math.max(0, i - 1);
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = btns.length - 1;
        else return;
        e.preventDefault();
        if (btns[n]) btns[n].click();
      });
      return bar;
    }

    function partDetails(d, p) {
      if (!p) return h('div', { class: 'card dk-card' }, h('div', { class: 'body-strong' }, t('partitionDetails')), h('div', { class: 'caption text-2' }, d.partitions.length || d.fs ? t('selectVolume') : t('noPartitions')));
      const mp = p.mountpoint;
      const total = p.fssize || p.size;
      const usage =
        p.used != null && mp
          ? h('div', { class: 'dk-usage' },
              h('div', { class: 'progress' }, h('div', { class: 'bar', style: { width: `${Math.round(Math.min(1, p.used / total) * 100)}%` } })),
              h('div', { class: 'caption text-2' }, t('usedOf', { used: size(p.used), size: size(total), free: size(p.avail) })))
          : t('none');
      const busy = !!state.busy;
      const canMount = !p.swap && p.fstype && !mp && !p.mountpoints.length;
      const actions = h(
        'div',
        { class: 'dk-actions' },
        canMount ? h('button', { class: 'btn dk-mount', disabled: busy, onclick: () => mountPart(d, p) }, icon('plug_connected'), t('mount')) : '',
        mp && !p.system ? h('button', { class: 'btn dk-unmount', disabled: busy, onclick: () => unmountPart(d, p) }, icon('plug_disconnected'), t('unmount')) : '',
        mp ? h('button', { class: 'btn subtle dk-open', disabled: busy, onclick: () => shell.launch('files', { path: mp }) }, icon('folder_open'), t('open')) : '',
      );
      return h(
        'div',
        { class: 'card dk-card dk-part' },
        h('div', { class: 'dk-card-head' }, h('div', { class: 'body-strong' }, `${t('partitionDetails')} · ${partName(p)}`), actions),
        row(t('f.device'), p.path),
        row(t('f.fs'), [fsLabel(p), p.fstype && p.fsver && p.fstype !== 'vfat' ? ` ${p.fsver}` : ''].join('')),
        row(t('f.label'), p.label || t('none')),
        row(t('f.size'), size(p.size)),
        row(t('f.mountpoint'), mp || (p.swap ? t('swap') : t('notMounted'))),
        row(t('f.usage'), usage),
        row(t('f.type'), p.parttypename || t('none')),
        row(t('f.uuid'), p.uuid || t('none')),
      );
    }

    function driveDetails(d) {
      return h(
        'div',
        { class: 'card dk-card dk-info' },
        h('div', { class: 'body-strong' }, t('driveDetails')),
        row(t('f.model'), d.model || t('none')),
        row(t('f.serial'), d.serial || t('none')),
        row(t('f.firmware'), d.rev || t('none')),
        row(t('f.size'), `${size(d.size)} (${nf(d.size, 0)} ${lang() === 'fr' ? 'octets' : 'bytes'})`),
        row(t('f.connection'), tranLabel(d)),
        row(t('f.media'), d.type === 'rom' ? t('optical') : d.rotational ? t('hdd') : t('ssd')),
        row(t('f.table'), d.pttype ? t(`tables.${d.pttype}`) : t('none')),
        row(t('f.removable'), d.removable ? t('yes') : t('no')),
        row(t('f.smart'), hv.smartRow(d, () => setView('health', true))),
      );
    }

    const VIEWS = ['volumes', 'health'];
    function setView(v, focus) {
      if (!VIEWS.includes(v)) return;
      state.view = v;
      renderMain();
      if (focus) mainEl.querySelector(`.dk-tab[data-view="${v}"]`)?.focus();
    }
    function tabs(d) {
      const bar = h(
        'div',
        { class: 'tabs dk-tabs', role: 'tablist', 'aria-label': t('tabs.label') },
        VIEWS.map((v) =>
          h(
            'button',
            {
              class: ['tab', 'dk-tab', state.view === v && 'selected'],
              role: 'tab',
              id: `dk-tab-${v}`,
              'aria-selected': state.view === v ? 'true' : 'false',
              'aria-controls': 'dk-view',
              tabindex: state.view === v ? '0' : '-1',
              'data-view': v,
              'data-fid': `tab-${v}`, // keeps the focus when a health read re-renders the view
              onclick: () => setView(v, true),
            },
            t(`tabs.${v}`),
            v === 'health' ? hv.tabBadge(d) : '',
          ),
        ),
      );
      bar.addEventListener('keydown', (e) => {
        const i = VIEWS.indexOf(state.view);
        let n = null;
        if (e.key === 'ArrowRight') n = VIEWS[(i + 1) % VIEWS.length];
        else if (e.key === 'ArrowLeft') n = VIEWS[(i + VIEWS.length - 1) % VIEWS.length];
        else if (e.key === 'Home') n = VIEWS[0];
        else if (e.key === 'End') n = VIEWS[VIEWS.length - 1];
        if (n) {
          e.preventDefault();
          setView(n, true);
        }
      });
      return bar;
    }

    function renderMain() {
      const d = selDrive();
      const segFocused = mainEl.contains(document.activeElement) && !!document.activeElement.classList?.contains('dk-seg');
      // Re-rendering (self-test progress, health reads) keeps the focused button focused.
      const fid = mainEl.contains(document.activeElement) ? document.activeElement.dataset?.fid || null : null;
      if (state.error) {
        mainEl.replaceChildren(h('div', { class: 'infobar error dk-error', role: 'alert' }, icon('error_circle'), h('div', null, state.error)), h('div', { class: 'dk-actions' }, h('button', { class: 'btn', onclick: () => load() }, t('refresh'))));
        return;
      }
      if (!d) {
        mainEl.replaceChildren(h('div', { class: 'empty dk-empty' }, icon('hard_drive', { size: 48 }), h('div', null, state.loading ? t('loading') : t('noDrives'))));
        return;
      }
      const busy = !!state.busy;
      const head = h(
        'div',
        { class: 'dk-head' },
        h('span', { class: 'dk-head-icon' }, icon(driveIcon(d), { size: 40 })),
        h('div', { class: 'dk-head-text' },
          h('div', { class: 'title dk-title' }, driveName(d)),
          h('div', { class: 'caption text-2' }, [d.path, size(d.size), tranLabel(d)].join(' · '))),
        h(
          'div',
          { class: 'dk-head-actions' },
          d.removable && !d.system ? h('button', { class: 'btn dk-eject', disabled: busy, onclick: () => eject(d) }, icon('arrow_eject'), t('eject')) : '',
          d.formattable ? h('button', { class: 'btn dk-format', disabled: busy, onclick: () => formatDrive(d) }, icon('warning'), t('format')) : '',
        ),
      );
      const volumesView = () => [
        d.system ? h('div', { class: 'infobar dk-syshint' }, icon('info'), h('div', null, t('systemHint'))) : '',
        h('div', { class: 'card dk-card dk-volumes' }, h('div', { class: 'body-strong' }, t('volumes')), partitionBar(d)),
        h('div', { class: 'dk-grid' }, partDetails(d, selPart()), driveDetails(d)),
      ];
      const parts = [
        head,
        note(),
        state.busy ? h('div', { class: 'dk-busy', role: 'status' }, h('div', { class: 'progress indeterminate' }, h('div', { class: 'bar' })), h('div', { class: 'caption' }, state.busy)) : '',
        tabs(d),
        h('div', { class: ['dk-view', `dk-view-${state.view}`], id: 'dk-view', role: 'tabpanel', 'aria-labelledby': `dk-tab-${state.view}` },
          state.view === 'health' ? hv.view(d) : volumesView()),
      ].filter(Boolean);
      mainEl.replaceChildren(...parts);
      if (segFocused) mainEl.querySelector('.dk-seg.selected')?.focus();
      else if (fid) mainEl.querySelector(`[data-fid="${fid}"]`)?.focus();
    }

    // ------------------------------------------------------------ actions
    function fail(e, d) {
      const msg = e?.message || String(e);
      state.note = { kind: 'error', text: e?.code === 'EBUSY' ? t('busy', { name: driveName(d) }) : t('actionFailed', { msg }) };
    }
    async function act(d, label, fn) {
      if (state.busy) return;
      state.busy = label;
      state.note = null;
      renderMain();
      try {
        await fn();
      } catch (e) {
        if (!win.closed) fail(e, d);
      }
      if (win.closed) return;
      state.busy = '';
      await load({ quiet: true });
    }
    const mountPart = (d, p) =>
      act(d, '', async () => {
        const at = await api.invoke('disks:mount', p.path);
        state.note = { kind: 'success', text: t('mounted', { name: partName(p), path: at || '' }) };
      });
    const unmountPart = (d, p) =>
      act(d, '', async () => {
        await api.invoke('disks:unmount', p.path);
        state.note = { kind: 'success', text: t('unmounted', { name: partName(p) }) };
      });
    const eject = (d) =>
      act(d, '', async () => {
        await api.invoke('disks:powerOff', d.path);
        shell.notify?.({ title: t('eject'), body: t('ejected', { name: driveName(d) }), appId: 'disks' });
        state.sel = null;
        state.note = null;
      });

    async function formatDrive(d) {
      if (!d.formattable) {
        state.note = { kind: 'warning', text: t('notFormattable') };
        return renderMain();
      }
      const name = driveName(d);
      const fsSel = h('select', { class: 'select dk-fs', 'aria-label': t('formatFs') },
        h('option', { value: 'vfat' }, t('fsVfat')), h('option', { value: 'exfat' }, t('fsExfat')), h('option', { value: 'ext4' }, t('fsExt4')));
      if (d.size > 32e9) fsSel.value = 'exfat';
      const labelIn = h('input', { class: 'input dk-label', value: (d.vendor || 'USB').slice(0, 11).toUpperCase().replace(/[^A-Z0-9_ -]/g, ''), maxlength: '16', 'aria-label': t('formatLabel') });
      const confirmIn = h('input', { class: 'input dk-confirm', placeholder: name, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('formatConfirm', { name }) });
      const hint = h('div', { class: 'field-hint dk-format-err', role: 'alert' });
      const body = h(
        'div',
        { class: 'dk-format-body' },
        h('div', { class: 'infobar warning' }, icon('warning'), h('div', null, t('formatWarn', { name, size: size(d.size) }))),
        h('div', { class: 'field' }, h('label', null, t('formatFs')), fsSel),
        h('div', { class: 'field' }, h('label', null, t('formatLabel')), labelIn),
        h('div', { class: 'field' }, h('label', null, t('formatConfirm', { name })), confirmIn),
        hint,
      );
      const problem = () => {
        const lab = labelIn.value;
        if (!/^[A-Za-z0-9_ -]*$/.test(lab)) return t('labelInvalid');
        if (lab.length > LABEL_MAX[fsSel.value]) return t('labelTooLong', { count: LABEL_MAX[fsSel.value] });
        if (confirmIn.value.trim() !== name) return confirmIn.value ? t('formatMismatch') : ' ';
        return '';
      };
      const v = await ui.dialog({
        title: t('formatTitle', { name }),
        body,
        parent: win,
        className: 'dk-format-dialog',
        width: 460,
        buttons: [
          { label: t('formatGo'), value: 'go', danger: true, primary: true },
          { label: t('common.cancel'), value: null },
        ],
        onOpen: (dlg) => {
          const go = dlg.querySelector('.dialog-footer .btn');
          go?.classList.add('dk-format-go');
          const upd = () => {
            const p = problem();
            if (go) go.disabled = !!p;
            hint.textContent = p.trim() && (labelIn.value || confirmIn.value) ? p : '';
          };
          [fsSel, labelIn, confirmIn].forEach((el) => el.addEventListener('input', upd));
          fsSel.addEventListener('change', upd);
          upd();
          dlg._validate = () => !problem();
          setTimeout(() => confirmIn.focus(), 40);
        },
      });
      if (v !== 'go' || win.closed) return;
      const fstype = fsSel.value;
      const label = fstype === 'vfat' ? labelIn.value.toUpperCase() : labelIn.value;
      state.busy = t('formatting', { name });
      state.note = null;
      renderMain();
      try {
        await shell.runAdmin('format-removable', [d.path, fstype, label], { reason: t('formatReason', { name }), appId: 'disks' });
        if (!win.closed) state.note = { kind: 'success', text: t('formatted', { name }) };
      } catch (e) {
        if (!win.closed && e?.code !== 'ECANCELED') state.note = { kind: 'error', text: t('formatFailed', { name, msg: e?.message || String(e) }) };
      }
      if (win.closed) return;
      state.busy = '';
      state.part = null;
      await load({ quiet: true });
    }

    root.addEventListener('keydown', (e) => {
      if ((e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) && !e.defaultPrevented) {
        e.preventDefault();
        load();
      }
    });

    ctx.onLangChange?.(() => {
      side.querySelector('.subtitle').textContent = t('drives');
      refreshBtn.title = t('refresh');
      refreshBtn.setAttribute('aria-label', t('refresh'));
      simNote.textContent = t('simulated');
      render();
    });

    api.invoke('admin:status').then((s) => {
      if (win.closed) return;
      state.isAdmin = s ? !!s.isAdmin : null;
      if (state.view === 'health') renderMain();
    }, () => {});
    api.invoke('disks:healthSchedule').then((s) => {
      if (s?.pollMs) state.pollMs = s.pollMs;
    }, () => {});

    render();
    await load();
    listEl.querySelector('.dk-drive.selected')?.focus();
    return {
      onRelaunch(next) {
        win.focus?.();
        if (next?.device && state.drives.some((d) => d.path === next.device)) {
          state.sel = next.device;
          state.part = volumes(selDrive())[0]?.path || null;
          if (next.view === 'health') state.view = 'health';
          render();
        }
        load({ quiet: true });
      },
    };
  },
};
