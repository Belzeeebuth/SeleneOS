// Reading pane: toolbar, header (subject, sender, recipients, date), blocked-pictures infobar,
// attachment chips and the sandboxed message body.
import { store } from './store.js';
import { buildMailDocument } from './sanitize.js';
import { errorText } from './setup.js';
import { avatarColor, initials, displayName, addressText, fullDate, fileKind } from './util.js';

export class Reader {
  constructor(ctx, app) {
    this.ctx = ctx;
    this.app = app;
    this.msg = null;
    this.allowRemote = false;
    const { h } = ctx;
    this.el = h('section', { class: 'ml-reader', 'aria-label': ctx.t('reader.label') });
    this.offTheme = ctx.settings.on('theme', () => this.msg && this.renderBody());
    this.offAccent = ctx.settings.on('accent', () => this.msg && this.renderBody());
    this.showEmpty();
  }

  t(k, v) {
    return this.ctx.t(k, v);
  }

  destroy() {
    this.offTheme?.();
    this.offAccent?.();
    this.barObs?.disconnect();
  }

  clear() {
    this.ctx.ui.clear(this.el);
    this.msg = null;
    this.frame = null;
    this.el.className = 'ml-reader';
  }

  showEmpty() {
    const { h, icon } = this.ctx;
    this.clear();
    this.el.classList.add('empty-state');
    this.el.appendChild(
      h(
        'div',
        { class: 'ml-reader-empty' },
        h('div', { class: 'ml-empty-art' }, icon('mail_read', { size: 56 })),
        h('div', { class: 'subtitle' }, this.t('reader.emptyTitle')),
        h('div', { class: 'text-2' }, this.t('reader.emptyText')),
      ),
    );
  }

  showMulti(count) {
    const { h, icon } = this.ctx;
    const t = (k, v) => this.t(k, v);
    this.clear();
    this.el.classList.add('empty-state');
    const act = (name, ic, label, fn) => h('button', { class: 'btn', name, onclick: fn }, icon(ic), label);
    this.el.appendChild(
      h(
        'div',
        { class: 'ml-reader-empty ml-multi' },
        h('div', { class: 'ml-empty-art' }, icon('mail_multiple', { size: 56 })),
        h('div', { class: 'subtitle', dataset: { count: String(count) } }, t('reader.selected', { count })),
        h(
          'div',
          { class: 'ml-multi-actions' },
          act('delete', 'delete', t('act.delete'), () => this.app.deleteSelected()),
          act('archive', 'archive', t('act.archive'), () => this.app.archiveSelected()),
          act('move', 'folder_arrow_right', t('act.move'), (e) => this.app.moveMenu(e)),
          act('read', 'mail_read', t('act.markRead'), () => this.app.setSelectedFlags({ seen: true })),
          act('unread', 'mail_unread', t('act.markUnread'), () => this.app.setSelectedFlags({ seen: false })),
          act('flag', 'flag', t('act.flag'), () => this.app.setSelectedFlags({ flagged: true })),
        ),
        h('button', { class: 'btn subtle', onclick: () => this.app.clearSelection() }, t('reader.clearSelection')),
      ),
    );
  }

  showLoading(summary) {
    const { h } = this.ctx;
    this.clear();
    this.el.classList.add('loading');
    this.el.appendChild(this.toolbar(null));
    this.el.appendChild(
      h(
        'div',
        { class: 'ml-reader-head' },
        h('div', { class: 'ml-subject-line' }, h('h2', { class: 'ml-read-subject' }, summary?.subject || this.t('list.noSubject'))),
        h('div', { class: 'ml-skeleton' }, h('span', { class: 'sk sk-avatar' }), h('span', { class: 'sk sk-line w60' }), h('span', { class: 'sk sk-line w40' })),
      ),
      h('div', { class: 'ml-body-wrap' }, h('div', { class: 'ml-skel-body' }, h('span', { class: 'sk sk-line w90' }), h('span', { class: 'sk sk-line w80' }), h('span', { class: 'sk sk-line w60' }))),
    );
  }

  showError(e, retry) {
    const { h, icon } = this.ctx;
    this.clear();
    this.el.classList.add('empty-state');
    const info = errorText(this.ctx.t, e);
    this.el.appendChild(
      h(
        'div',
        { class: 'ml-reader-empty' },
        h('div', { class: 'ml-empty-art error' }, icon('error_circle', { size: 48 })),
        h('div', { class: 'subtitle' }, this.t('reader.openFailed')),
        h('div', { class: 'text-2' }, info.text),
        info.detail ? h('div', { class: 'caption text-3 selectable' }, info.detail) : null,
        retry ? h('button', { class: 'btn', onclick: retry }, this.t('reader.retry')) : null,
      ),
    );
  }

  // ------------------------------------------------------------ toolbar
  toolbar(msg) {
    const { h, icon } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const dis = !msg;
    const file = msg?.accountId === '@file';
    const b = (name, ic, label, fn, opts = {}) =>
      h(
        'button',
        { class: ['btn', 'subtle', 'ml-tb', opts.iconOnly && 'icon-only', opts.cls], name, disabled: dis || opts.disabled, 'data-tip': opts.tip || label, 'aria-label': label, onclick: fn },
        icon(ic, { filled: opts.filled }),
        h('span', { class: 'lbl' }, label),
        opts.chevron ? icon('chevron_down', { size: 10, class: 'chev' }) : null,
      );
    const app = this.app;
    const narrowBack = h('button', { class: 'btn subtle icon-btn ml-back', name: 'back', 'aria-label': t('reader.back'), 'data-tip': t('reader.back'), onclick: () => app.backToList() }, icon('arrow_left'));
    const flagged = !!msg?.flagged;
    const bar = h(
      'div',
      { class: 'ml-read-bar', role: 'toolbar', 'aria-label': t('reader.toolbar') },
      narrowBack,
      b('reply', 'arrow_reply', t('act.reply'), () => app.reply('reply'), { tip: `${t('act.reply')} (Ctrl+R)`, disabled: file }),
      b('replyAll', 'arrow_reply_all', t('act.replyAll'), () => app.reply('replyAll'), { tip: `${t('act.replyAll')} (Ctrl+Shift+R)`, disabled: file }),
      b('forward', 'arrow_forward', t('act.forward'), () => app.reply('forward'), { tip: `${t('act.forward')} (Ctrl+F)`, disabled: file }),
      h('span', { class: 'vsep' }),
      b('delete', 'delete', t('act.delete'), () => app.deleteSelected(), { tip: `${t('act.delete')} (Suppr)`.replace('Suppr', this.ctx.lang === 'fr' ? 'Suppr' : 'Delete'), disabled: file }),
      b('archive', 'archive', t('act.archive'), () => app.archiveSelected(), { disabled: file || app.folderSpecial() === 'archive' }),
      b('move', 'folder_arrow_right', t('act.move'), (e) => app.moveMenu(e), { chevron: true, disabled: file }),
      h('span', { class: 'vsep' }),
      b('flag', flagged ? 'flag_off' : 'flag', flagged ? t('act.unflag') : t('act.flag'), () => app.setSelectedFlags({ flagged: !flagged }), { cls: flagged && 'on', disabled: file }),
      b('unread', msg?.seen === false ? 'mail_read' : 'mail_unread', msg?.seen === false ? t('act.markRead') : t('act.markUnread'), () => app.setSelectedFlags({ seen: msg?.seen === false }), { disabled: file }),
      h('span', { class: 'grow' }),
      b('more', 'more_horizontal', t('act.more'), (e) => this.moreMenu(e), { iconOnly: true }),
    );
    this.fitToolbar(bar);
    return bar;
  }

  // Like Outlook's simplified ribbon: drop labels (then Archive/Move, reachable from "…")
  // until the toolbar fits, whatever the language and window width.
  fitToolbar(bar) {
    this.barObs?.disconnect();
    const fit = () => {
      if (!bar.isConnected) return;
      for (let level = 0; level <= 4; level++) {
        bar.dataset.compact = String(level);
        if (bar.scrollWidth <= bar.clientWidth + 1) return;
      }
    };
    this.barObs = new ResizeObserver(() => requestAnimationFrame(fit));
    this.barObs.observe(bar);
    requestAnimationFrame(fit);
  }

  async moreMenu(e) {
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const msg = this.msg;
    if (!msg) return;
    const file = msg.accountId === '@file';
    const dark = document.documentElement.dataset.theme === 'dark';
    const special = this.app.folderSpecial();
    const sender = msg.from?.[0]?.address;
    const compact = Number(this.el.querySelector('.ml-read-bar')?.dataset.compact || 0);
    await ui.menu(e, [
      compact >= 4 && !file ? { label: t('act.archive'), icon: 'archive', disabled: special === 'archive', action: () => this.app.archiveSelected() } : null,
      compact >= 4 && !file ? { label: t('act.move'), icon: 'folder_arrow_right', action: () => this.app.moveMenu(e) } : null,
      compact >= 4 && !file ? '-' : null,
      { label: t('act.reply'), icon: 'arrow_reply', shortcut: 'Ctrl+R', disabled: file, action: () => this.app.reply('reply') },
      { label: t('act.replyAll'), icon: 'arrow_reply_all', shortcut: 'Ctrl+Shift+R', disabled: file, action: () => this.app.reply('replyAll') },
      { label: t('act.forward'), icon: 'arrow_forward', shortcut: 'Ctrl+F', disabled: file, action: () => this.app.reply('forward') },
      '-',
      !file && special !== 'junk' ? { label: t('act.junk'), icon: 'mail_prohibited', action: () => this.app.moveToSpecial('junk') } : null,
      !file && special === 'junk' ? { label: t('act.notJunk'), icon: 'mail_inbox', action: () => this.app.moveToSpecial('inbox') } : null,
      this.remote && !this.allowRemote ? { label: t('reader.showPictures'), icon: 'image', action: () => this.showPictures() } : null,
      sender && this.remote ? { label: store.isTrustedSender(sender) ? t('reader.untrustSender') : t('reader.trustSender'), icon: 'shield', action: () => this.toggleTrust(sender) } : null,
      dark && this.isHtml ? { label: store.prefs.darkAdapt ? t('reader.lightBackground') : t('reader.darkBackground'), icon: store.prefs.darkAdapt ? 'weather_sunny' : 'weather_moon', action: () => this.toggleAdapt() } : null,
      '-',
      !file && this.app.openStandalone ? { label: t('reader.newWindow'), icon: 'window_new', action: () => this.app.openStandalone(msg) } : null,
      !file ? { label: t('reader.saveEml'), icon: 'save', action: () => this.app.saveAsEml(msg) } : null,
      !file ? { label: t('reader.viewSource'), icon: 'code', action: () => this.app.viewSource(msg) } : null,
    ].filter(Boolean));
  }

  // ------------------------------------------------------------ message
  showMessage(msg) {
    const { h, icon, i18n } = this.ctx;
    const t = (k, v) => this.t(k, v);
    this.clear();
    this.msg = msg;
    const sender = msg.from?.[0] || { name: '', address: '' };
    this.allowRemote = store.prefs.remoteImages === 'always' || store.isTrustedSender(sender.address) || !!msg.allowRemote;
    const recip = (label, list) =>
      list?.length
        ? h(
            'div',
            { class: 'ml-recips caption' },
            h('span', { class: 'text-2 ml-recips-label' }, label),
            h('span', { class: 'ml-recips-list selectable' }, list.map((a, i) => h('span', { class: 'ml-recip', title: addressText(a) }, displayName(a) + (i < list.length - 1 ? '; ' : '')))),
          )
        : null;
    const flags = h('span', { class: 'ml-head-flags' }, msg.flagged ? icon('flag', { filled: true, class: 'ml-flag-on', size: 16 }) : null);
    this.headEl = h(
      'div',
      { class: 'ml-reader-head' },
      h('div', { class: 'ml-subject-line' }, h('h2', { class: 'ml-read-subject selectable' }, msg.subject || t('list.noSubject')), flags),
      h(
        'div',
        { class: 'ml-sender-row' },
        h('span', { class: 'ml-avatar lg', style: { background: avatarColor(sender.address || sender.name) }, 'aria-hidden': 'true' }, initials(sender.name, sender.address)),
        h(
          'div',
          { class: 'ml-sender-text' },
          h(
            'div',
            { class: 'ml-sender-name' },
            h('span', { class: 'body-strong selectable', title: sender.address }, sender.name || sender.address || t('reader.unknownSender')),
            sender.name && sender.address ? h('span', { class: 'text-2 ml-sender-addr selectable' }, `<${sender.address}>`) : null,
          ),
          recip(t('reader.to'), msg.to),
          recip(t('reader.cc'), msg.cc),
          msg.bcc?.length ? recip(t('reader.bcc'), msg.bcc) : null,
        ),
        h('div', { class: 'ml-read-date caption text-2', title: fullDate(msg.date, i18n) }, fullDate(msg.date, i18n)),
      ),
    );
    this.infoEl = h('div', { class: 'ml-read-info' });
    const atts = (msg.attachments || []).filter((a) => !a.inline);
    this.attEl = atts.length ? this.attachments(atts) : null;
    this.frameWrap = h('div', { class: 'ml-body-wrap' });
    this.el.append(this.toolbar(msg), h('div', { class: 'ml-reader-scroll' }, this.headEl, this.infoEl, this.attEl, this.frameWrap));
    this.renderBody();
  }

  attachments(list) {
    const { h, icon, i18n } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const total = list.reduce((s, a) => s + (a.size || 0), 0);
    return h(
      'div',
      { class: 'ml-read-atts' },
      h('div', { class: 'ml-atts-head caption text-2' }, h('span', null, t('reader.attachments', { count: list.length }), ` · ${i18n.formatSize(total)}`), list.length > 1 ? h('button', { class: 'btn subtle small', name: 'save-all', onclick: () => this.app.saveAllAttachments(this.msg, list) }, icon('arrow_download', { size: 14 }), t('reader.saveAll')) : null),
      h(
        'div',
        { class: 'ml-atts' },
        list.map((a) => {
          const k = fileKind(a.filename, a.contentType);
          const chip = h(
            'div',
            {
              class: 'ml-att reading',
              tabindex: '0',
              role: 'button',
              dataset: { id: String(a.id), name: a.filename },
              title: a.filename,
              onclick: (e) => (e.target.closest('.ml-att-menu') ? null : this.app.openAttachment(this.msg, a)),
              onkeydown: (e) => {
                if (e.key === 'Enter') this.app.openAttachment(this.msg, a);
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) this.attMenu(e, a);
              },
              oncontextmenu: (e) => this.attMenu(e, a),
            },
            h('span', { class: 'ml-att-icon', style: { color: k.color } }, icon(k.icon, { size: 24 })),
            h('span', { class: 'ml-att-text' }, h('span', { class: 'ml-att-name ellipsis' }, a.filename), h('span', { class: 'caption text-2' }, i18n.formatSize(a.size))),
            h('button', { class: 'btn subtle icon-btn small ml-att-menu', 'aria-label': t('reader.attachmentMenu'), 'data-tip': t('reader.attachmentMenu'), onclick: (e) => (e.stopPropagation(), this.attMenu(e, a)) }, icon('chevron_down', { size: 12 })),
          );
          return chip;
        }),
      ),
    );
  }

  async attMenu(e, a) {
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    await ui.menu(e, [
      { label: t('reader.open'), icon: 'open', action: () => this.app.openAttachment(this.msg, a) },
      { label: t('reader.save'), icon: 'arrow_download', action: () => this.app.saveAttachment(this.msg, a) },
      { label: t('reader.saveAs'), icon: 'save', action: () => this.app.saveAttachment(this.msg, a, { ask: true }) },
    ]);
  }

  renderBody() {
    const msg = this.msg;
    if (!msg || !this.frameWrap) return;
    const { h, icon, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const dark = document.documentElement.dataset.theme === 'dark';
    const css = getComputedStyle(document.documentElement);
    const doc = buildMailDocument({
      html: msg.html,
      text: msg.text,
      cids: msg.inlineCids || {},
      allowRemote: this.allowRemote,
      theme: dark ? 'dark' : 'light',
      adapt: dark && store.prefs.darkAdapt,
      accent: css.getPropertyValue('--accent-text').trim() || '#005fb8',
      accentDark: css.getPropertyValue('--accent-text').trim() || '#60cdff',
    });
    this.remote = doc.remote;
    this.isHtml = doc.isHtml;
    ui.clear(this.infoEl);
    if (doc.remote && !this.allowRemote) {
      const sender = msg.from?.[0]?.address;
      this.infoEl.appendChild(
        h(
          'div',
          { class: 'infobar ml-pictures-bar', role: 'status' },
          icon('image_off'),
          h('div', { class: 'grow' }, t('reader.picturesBlocked')),
          h('div', { class: 'ml-infobar-actions' }, h('button', { class: 'btn small', name: 'show-pictures', onclick: () => this.showPictures() }, t('reader.showPictures')), sender ? h('button', { class: 'btn subtle small', name: 'trust-sender', onclick: () => this.toggleTrust(sender) }, t('reader.alwaysShow')) : null),
        ),
      );
    }
    const frame = h('iframe', {
      class: ['ml-frame', doc.isHtml ? 'html' : 'text', doc.isHtml && dark && store.prefs.darkAdapt && 'adapted'],
      sandbox: 'allow-popups allow-popups-to-escape-sandbox',
      referrerpolicy: 'no-referrer',
      title: t('reader.bodyLabel'),
      tabindex: '0',
    });
    frame.srcdoc = doc.srcdoc;
    ui.clear(this.frameWrap);
    this.frameWrap.className = ['ml-body-wrap', doc.isHtml ? 'html' : 'text', doc.isHtml && dark && store.prefs.darkAdapt && 'adapted'].filter(Boolean).join(' ');
    this.frameWrap.appendChild(frame);
    this.frame = frame;
  }

  showPictures() {
    this.allowRemote = true;
    this.renderBody();
  }

  toggleTrust(address) {
    const trusted = store.isTrustedSender(address);
    store.trustSender(address, !trusted);
    this.allowRemote = !trusted || store.prefs.remoteImages === 'always';
    this.renderBody();
  }

  toggleAdapt() {
    store.setPref('darkAdapt', !store.prefs.darkAdapt);
    this.renderBody();
  }

  // Update toolbar/header after a flag change without reloading the body.
  updateFlags(patch) {
    if (!this.msg) return;
    Object.assign(this.msg, patch);
    const bar = this.el.querySelector('.ml-read-bar');
    if (bar) bar.replaceWith(this.toolbar(this.msg));
    const flags = this.headEl?.querySelector('.ml-head-flags');
    if (flags) {
      this.ctx.ui.clear(flags);
      if (this.msg.flagged) flags.appendChild(this.ctx.icon('flag', { filled: true, class: 'ml-flag-on', size: 16 }));
    }
  }
}
