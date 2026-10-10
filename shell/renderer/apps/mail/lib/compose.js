// Message composer (inline in the reading pane or in its own window).
//   const c = new Composer(ctx, { accountId, mode: 'new'|'reply'|'replyAll'|'forward'|'draft'|'restore',
//                                 original, to, cc, bcc, subject, body, html, attachments, standalone, onClose(reason) });
//   container.appendChild(c.el); c.focus();
//   await c.close() -> false when the user cancelled (unsaved changes prompt)
import { store } from './store.js';
import { AddressField } from './chips.js';
import { sanitizeForCompose, plainToComposeHtml } from './sanitize.js';
import { errorText } from './setup.js';
import { escapeHtml, textToHtml, htmlToText, fullDate, addressText, displayName, sameAddress, prefixSubject, fileKind, isEmail } from './util.js';

const BIG_ATTACHMENTS = 25 * 1024 * 1024;

export function signatureOf(account, t) {
  if (!account || account.signatureEnabled === false) return '';
  return account.signature ?? t('compose.defaultSignature');
}

// Recipients and subject of a reply / forward.
export function replyFields(original, mode, account, t) {
  const self = account?.email || '';
  const notSelf = (list) => (list || []).filter((a) => !sameAddress(a.address, self));
  const uniq = (list) => {
    const seen = new Set();
    return list.filter((a) => {
      const k = String(a.address || '').toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const fromSelf = (original.from || []).some((a) => sameAddress(a.address, self));
  let to = [];
  let cc = [];
  if (mode === 'reply' || mode === 'replyAll') {
    to = original.replyTo?.length ? original.replyTo : original.from || [];
    if (fromSelf) to = original.to || []; // replying to something we sent
    if (mode === 'replyAll') {
      const rest = fromSelf ? original.cc || [] : [...(original.to || []), ...(original.cc || [])];
      cc = notSelf(rest).filter((a) => !to.some((b) => sameAddress(a.address, b.address)));
    }
    to = uniq(fromSelf ? to : notSelf(to).length ? notSelf(to) : to);
    cc = uniq(cc);
  }
  const subject = mode === 'forward' ? prefixSubject(original.subject, t('compose.fwdPrefix')) : prefixSubject(original.subject, t('compose.rePrefix'));
  const references = [...(original.references || [])];
  if (original.messageId && !references.includes(original.messageId)) references.push(original.messageId);
  return { to, cc, subject, inReplyTo: mode === 'forward' ? null : original.messageId || null, references: mode === 'forward' ? [] : references };
}

export class Composer {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.accountId = opts.accountId || store.prefs.lastAccount || store.accounts[0]?.id;
    this.mode = opts.mode || 'new';
    this.original = opts.original || null;
    this.attachments = [...(opts.attachments || [])]; // [{path, filename, size}]
    this.plain = !!opts.plain;
    this.dirty = false;
    this.sending = false;
    this.closed = false;
    this.draft = opts.draft || null; // { folder, uid } once saved on the server
    this.inReplyTo = opts.inReplyTo || null;
    this.references = opts.references || [];
    this.origin = opts.origin || null;
    this.build();
  }

  t(k, v) {
    return this.ctx.t(k, v);
  }

  get account() {
    return store.account(this.accountId) || store.accounts[0];
  }

  // ------------------------------------------------------------ DOM
  build() {
    const { h, icon, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const o = this.opts;
    let to = o.to || [];
    let cc = o.cc || [];
    const bcc = o.bcc || [];
    let subject = o.subject || '';
    if (this.original && ['reply', 'replyAll', 'forward'].includes(this.mode)) {
      const f = replyFields(this.original, this.mode, this.account, t);
      to = f.to;
      cc = f.cc;
      subject = f.subject;
      this.inReplyTo = f.inReplyTo;
      this.references = f.references;
      this.origin = { folder: this.original.folder, uid: this.original.uid, action: this.mode === 'forward' ? 'forward' : 'reply' };
    }

    const mark = () => this.markDirty();
    this.sendBtn = h('button', { class: 'btn primary ml-send', name: 'send', 'data-tip': t('compose.sendTip'), onclick: () => this.send() }, icon('send', { filled: true }), h('span', { class: 'lbl' }, t('compose.send')));
    this.status = h('span', { class: 'ml-compose-status caption text-2', role: 'status', 'aria-live': 'polite' });
    const tb = (name, ic, label, fn, extra = {}) => h('button', { class: 'btn subtle ml-tb', name, 'data-tip': label, 'aria-label': label, onclick: fn, ...extra }, icon(ic), h('span', { class: 'lbl' }, label));
    this.toolbar = h(
      'div',
      { class: 'ml-compose-bar' },
      this.sendBtn,
      tb('discard', 'delete', t('compose.discard'), () => this.discard()),
      h('span', { class: 'vsep' }),
      tb('attach', 'attach', t('compose.attach'), () => this.pickFiles()),
      tb('more', 'more_horizontal', t('compose.more'), (e) => this.moreMenu(e), { class: 'btn subtle ml-tb icon-only' }),
      h('span', { class: 'grow' }),
      this.status,
      !o.standalone ? h('button', { class: 'btn subtle icon-btn', name: 'popout', 'data-tip': t('compose.popOut'), 'aria-label': t('compose.popOut'), onclick: () => this.popOut() }, icon('window_new')) : null,
    );

    // From
    const accounts = store.accounts;
    this.fromSel =
      accounts.length > 1
        ? ui.select({
            options: accounts.map((a) => ({ value: a.id, label: a.name ? `${a.name} <${a.email}>` : a.email })),
            value: this.accountId,
            onchange: (v) => {
              const prevSig = signatureOf(this.account, t);
              this.accountId = v;
              this.swapSignature(prevSig);
              mark();
            },
          })
        : h('span', { class: 'ml-from-static' }, this.account ? addressText({ name: this.account.name, address: this.account.email }) : '');
    this.fromSel.classList?.add('ml-from');
    const fromRow = h('div', { class: 'ml-field' }, h('label', { class: 'ml-field-label' }, t('compose.from')), this.fromSel);

    this.ccBtn = h('button', { class: 'btn subtle small ml-ccbtn', type: 'button', name: 'show-cc', onclick: () => this.showField('cc') }, t('compose.cc'));
    this.bccBtn = h('button', { class: 'btn subtle small ml-ccbtn', type: 'button', name: 'show-bcc', onclick: () => this.showField('bcc') }, t('compose.bcc'));
    this.to = new AddressField(this.ctx, { label: t('compose.to'), name: 'to', value: to, onChange: mark, extra: h('span', { class: 'ml-ccbtns' }, this.ccBtn, this.bccBtn) });
    this.cc = new AddressField(this.ctx, { label: t('compose.cc'), name: 'cc', value: cc, onChange: mark });
    this.bcc = new AddressField(this.ctx, { label: t('compose.bcc'), name: 'bcc', value: bcc, onChange: mark });
    this.cc.el.hidden = !cc.length;
    this.bcc.el.hidden = !bcc.length;
    this.ccBtn.hidden = !!cc.length;
    this.bccBtn.hidden = !!bcc.length;
    this.subject = h('input', { class: 'ml-subject', name: 'subject', placeholder: t('compose.subject'), 'aria-label': t('compose.subject'), value: subject, spellcheck: true });
    this.subject.addEventListener('input', () => {
      mark();
      this.opts.onTitle?.(this.subject.value);
    });

    // Formatting bar
    const fmt = (cmd, ic, label, fn) => {
      const b = h('button', { class: 'btn subtle icon-btn ml-fmt', type: 'button', name: `fmt-${cmd}`, 'data-tip': label, 'aria-label': label, 'aria-pressed': 'false' }, icon(ic));
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor selection
      b.addEventListener('click', () => {
        if (fn) fn();
        else this.exec(cmd);
      });
      return b;
    };
    this.fmtButtons = {
      bold: fmt('bold', 'text_bold', t('fmt.bold')),
      italic: fmt('italic', 'text_italic', t('fmt.italic')),
      underline: fmt('underline', 'text_underline', t('fmt.underline')),
      insertUnorderedList: fmt('insertUnorderedList', 'text_bullet_list_ltr', t('fmt.bullets')),
      insertOrderedList: fmt('insertOrderedList', 'text_number_list_ltr', t('fmt.numbering')),
    };
    this.formatBar = h(
      'div',
      { class: 'ml-format-bar', role: 'toolbar', 'aria-label': t('fmt.toolbar') },
      this.fmtButtons.bold,
      this.fmtButtons.italic,
      this.fmtButtons.underline,
      h('span', { class: 'vsep' }),
      this.fmtButtons.insertUnorderedList,
      this.fmtButtons.insertOrderedList,
      h('span', { class: 'vsep' }),
      fmt('link', 'link', t('fmt.link'), () => this.insertLink()),
      fmt('removeFormat', 'text_clear_formatting', t('fmt.clear'), () => {
        this.exec('removeFormat');
        this.exec('unlink');
      }),
    );

    // Editor
    this.editor = h('div', { class: 'ml-editor', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('compose.body'), spellcheck: true });
    this.textarea = h('textarea', { class: 'ml-editor-plain', name: 'body-plain', 'aria-label': t('compose.body'), spellcheck: true, hidden: true });
    this.editor.addEventListener('input', mark);
    this.textarea.addEventListener('input', mark);
    this.editor.addEventListener('paste', (e) => this.onPaste(e));
    this.editor.addEventListener('drop', (e) => this.onEditorDrop(e));
    this.editor.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.insertLink();
      }
    });
    this.selHandler = () => this.updateFormatState();
    document.addEventListener('selectionchange', this.selHandler);

    this.attachRow = h('div', { class: 'ml-attach-row', hidden: true });
    this.infobar = h('div', { class: 'ml-compose-info' });
    this.dropOverlay = h('div', { class: 'ml-drop-overlay', hidden: true }, icon('attach', { size: 32 }), h('div', { class: 'subtitle' }, t('compose.dropFiles')));

    this.el = h(
      'div',
      { class: ['ml-compose', o.standalone && 'standalone'], role: 'form', 'aria-label': t('compose.newMessage') },
      this.toolbar,
      h('div', { class: 'ml-compose-scroll' }, h('div', { class: 'ml-compose-fields' }, accounts.length > 1 ? fromRow : null, this.to.el, this.cc.el, this.bcc.el, h('div', { class: 'ml-field ml-subject-row' }, this.subject)), this.infobar, this.attachRow, this.formatBar, this.editor, this.textarea),
      this.dropOverlay,
    );
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.wireDrop();

    // Initial body
    this.setInitialBody();
    this.renderAttachments();
    this.setPlain(this.plain, { convert: false });
    this.dirty = this.mode === 'restore' ? !!o.dirty : false;
  }

  setInitialBody() {
    const t = (k, v) => this.t(k, v);
    const o = this.opts;
    const sig = signatureOf(this.account, t);
    const sigHtml = sig ? `<div class="ml-signature">${escapeHtml(sig).replace(/\n/g, '<br>')}</div>` : '';
    if (this.mode === 'draft' || this.mode === 'restore') {
      if (o.html) this.editor.replaceChildren(sanitizeForCompose(o.html, o.cids || {}));
      else this.editor.replaceChildren(sanitizeForCompose(plainToComposeHtml(o.body || '')));
      this.textarea.value = o.body ?? htmlToText(this.editor.innerHTML, { trim: false });
      return;
    }
    const intro = o.body ? plainToComposeHtml(o.body) : '<div><br></div>';
    let html = `${intro}${sig ? `<div><br></div>${sigHtml}` : ''}`;
    let text = `${o.body || ''}\n${sig ? `\n${sig}\n` : ''}`;
    const orig = this.original;
    const frag = document.createDocumentFragment();
    if (orig && ['reply', 'replyAll', 'forward'].includes(this.mode)) {
      const who = displayName(orig.from?.[0]) || t('reader.unknownSender');
      const date = fullDate(orig.date, this.ctx.i18n);
      const body = orig.html ? orig.html : `<div style="white-space:pre-wrap">${textToHtml(orig.text || '')}</div>`;
      if (this.mode === 'forward') {
        const head = [
          t('compose.fwdHeader'),
          `${t('compose.hFrom')} ${(orig.from || []).map(addressText).join(', ')}`,
          `${t('compose.hDate')} ${date}`,
          `${t('compose.hSubject')} ${orig.subject || ''}`,
          `${t('compose.hTo')} ${(orig.to || []).map(addressText).join(', ')}`,
          orig.cc?.length ? `${t('compose.hCc')} ${orig.cc.map(addressText).join(', ')}` : null,
        ].filter(Boolean);
        html += `<div><br></div><div class="ml-quote-head">${head.map(escapeHtml).join('<br>')}</div><div><br></div>`;
        const box = document.createElement('div');
        box.className = 'ml-forwarded';
        box.appendChild(sanitizeForCompose(body, orig.inlineCids || {}));
        frag.appendChild(box);
        text += `\n${head.join('\n')}\n\n${orig.text || htmlToText(orig.html || '')}`;
      } else {
        const head = t('compose.wrote', { date, name: who });
        html += `<div><br></div><div class="ml-quote-head">${escapeHtml(head)}</div>`;
        const bq = document.createElement('blockquote');
        bq.className = 'ml-quote';
        bq.setAttribute('style', 'margin: 0 0 0 0.8ex; border-left: 2px solid #c8c8c8; padding-left: 1ex');
        bq.appendChild(sanitizeForCompose(body, orig.inlineCids || {}));
        frag.appendChild(bq);
        const quoted = String(orig.text || htmlToText(orig.html || ''))
          .replace(/\r/g, '')
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        text += `\n${head}\n${quoted}`;
      }
    }
    this.editor.replaceChildren(sanitizeForCompose(html));
    this.editor.appendChild(frag);
    this.textarea.value = text.replace(/^\n/, '');
  }

  // Replace the old signature with the new account's one when "From" changes.
  swapSignature(prevSig) {
    const sig = signatureOf(this.account, (k, v) => this.t(k, v));
    const node = this.editor.querySelector('.ml-signature');
    if (node) {
      if (sig) node.innerHTML = escapeHtml(sig).replace(/\n/g, '<br>');
      else node.remove();
    }
    if (prevSig && this.textarea.value.includes(prevSig)) this.textarea.value = this.textarea.value.replace(prevSig, sig);
  }

  markDirty() {
    this.dirty = true;
    if (this.status.dataset.saved) {
      delete this.status.dataset.saved;
      this.status.textContent = '';
    }
  }

  showField(which) {
    const f = which === 'cc' ? this.cc : this.bcc;
    f.el.hidden = false;
    (which === 'cc' ? this.ccBtn : this.bccBtn).hidden = true;
    f.focus();
  }

  focus() {
    const run = () => {
      if (!this.to.chips.length && this.mode !== 'draft') this.to.focus();
      else if (!this.subject.value) this.subject.focus();
      else this.focusBody();
    };
    if (this.el.isConnected) run();
    else setTimeout(run, 30);
  }

  focusBody() {
    if (this.plain) {
      this.textarea.focus();
      this.textarea.setSelectionRange(0, 0);
      this.textarea.scrollTop = 0;
      return;
    }
    this.editor.focus();
    const r = document.createRange();
    r.setStart(this.editor, 0);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ------------------------------------------------------------ formatting
  exec(cmd, value = null) {
    if (this.plain) return;
    this.editor.focus();
    document.execCommand(cmd, false, value);
    this.markDirty();
    this.updateFormatState();
  }

  updateFormatState() {
    if (this.plain || !this.el.isConnected) return;
    const sel = window.getSelection();
    if (!sel?.rangeCount || !this.editor.contains(sel.anchorNode)) return;
    for (const [cmd, btn] of Object.entries(this.fmtButtons)) {
      let on = false;
      try {
        on = document.queryCommandState(cmd);
      } catch {}
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  async insertLink() {
    if (this.plain) return;
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const sel = window.getSelection();
    const range = sel?.rangeCount && this.editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const existing = range ? sel.anchorNode?.parentElement?.closest('a')?.getAttribute('href') : null;
    const url = await ui.prompt({
      title: t('fmt.linkTitle'),
      label: t('fmt.linkLabel'),
      value: existing || 'https://',
      parent: this.ctx.win,
      okLabel: t('fmt.insert'),
      select: false,
      validate: (v) => (/^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(v.trim()) ? null : t('fmt.badLink')),
    });
    if (!url) return;
    this.editor.focus();
    const s2 = window.getSelection();
    s2.removeAllRanges();
    if (range) s2.addRange(range);
    if (!range || range.collapsed) {
      const a = document.createElement('a');
      a.href = url.trim();
      a.textContent = url.trim();
      const r = s2.rangeCount ? s2.getRangeAt(0) : document.createRange();
      if (!s2.rangeCount) {
        r.selectNodeContents(this.editor);
        r.collapse(false);
      }
      r.insertNode(a);
      r.setStartAfter(a);
      r.collapse(true);
      s2.removeAllRanges();
      s2.addRange(r);
      this.markDirty();
    } else this.exec('createLink', url.trim());
  }

  onPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...(dt.files || [])];
    if (files.length && files.every((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      for (const f of files) {
        if (f.size > 5 * 1024 * 1024) continue;
        const reader = new FileReader();
        reader.onload = () => {
          if (/^data:image\/(png|jpe?g|gif|webp);base64,/.test(String(reader.result))) {
            const img = document.createElement('img');
            img.src = reader.result;
            img.style.maxWidth = '100%';
            this.insertNodeAtCursor(img);
          }
        };
        reader.readAsDataURL(f);
      }
      return;
    }
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    e.preventDefault();
    if (html) this.insertNodeAtCursor(sanitizeForCompose(html));
    else if (text) document.execCommand('insertText', false, text);
    this.markDirty();
  }

  insertNodeAtCursor(node) {
    const sel = window.getSelection();
    let r;
    if (sel?.rangeCount && this.editor.contains(sel.anchorNode)) {
      r = sel.getRangeAt(0);
      r.deleteContents();
    } else {
      r = document.createRange();
      r.selectNodeContents(this.editor);
      r.collapse(false);
    }
    const last = node.nodeType === 11 ? node.lastChild : node;
    r.insertNode(node);
    if (last) {
      r.setStartAfter(last);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    this.markDirty();
  }

  onEditorDrop(e) {
    if (this.dropPaths(e).length) return; // files are handled by the composer drop zone
    const html = e.dataTransfer?.getData('text/html');
    if (html) {
      e.preventDefault();
      this.insertNodeAtCursor(sanitizeForCompose(html));
    }
  }

  setPlain(on, { convert = true } = {}) {
    if (convert && on !== this.plain) {
      if (on) this.textarea.value = htmlToText(this.editor.innerHTML, { trim: false });
      else this.editor.replaceChildren(sanitizeForCompose(plainToComposeHtml(this.textarea.value)));
      this.markDirty();
    }
    this.plain = on;
    this.editor.hidden = on;
    this.textarea.hidden = !on;
    this.formatBar.hidden = on; // plain text has no formatting
  }

  async moreMenu(e) {
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    await ui.menu(e, [
      { label: t('compose.saveDraft'), icon: 'save', shortcut: 'Ctrl+S', action: () => this.saveDraft() },
      '-',
      { label: t('compose.showCc'), icon: 'person_add', disabled: !this.cc.el.hidden, action: () => this.showField('cc') },
      { label: t('compose.showBcc'), icon: 'person_add', disabled: !this.bcc.el.hidden, action: () => this.showField('bcc') },
      '-',
      {
        label: this.plain ? t('compose.switchHtml') : t('compose.switchPlain'),
        icon: 'text_edit_style',
        action: async () => {
          if (!this.plain && !(await ui.confirm(t('compose.plainConfirm'), { title: t('compose.switchPlain'), okLabel: t('compose.switchPlainOk'), parent: this.ctx.win }))) return;
          this.setPlain(!this.plain);
        },
      },
      !this.opts.standalone ? { label: t('compose.popOut'), icon: 'window_new', action: () => this.popOut() } : null,
    ].filter(Boolean));
  }

  // ------------------------------------------------------------ attachments
  dropPaths(e) {
    const dt = e.dataTransfer;
    if (!dt) return [];
    try {
      const raw = dt.getData('application/x-aurora-paths');
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list.filter((p) => typeof p === 'string' && p.startsWith('/'));
      }
    } catch {}
    const files = [...(dt.files || [])].map((f) => this.ctx.api.pathForFile(f)).filter(Boolean);
    if (files.length) return files;
    return (dt.getData('text/uri-list') || '')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('file://'))
      .map((l) => decodeURIComponent(l.slice(7)));
  }

  wireDrop() {
    let depth = 0;
    const hasFiles = (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes('Files') || types.includes('application/x-aurora-paths') || types.includes('text/uri-list');
    };
    this.el.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      this.dropOverlay.hidden = false;
    });
    this.el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    this.el.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.dropOverlay.hidden = true;
    });
    this.el.addEventListener('drop', (e) => {
      depth = 0;
      this.dropOverlay.hidden = true;
      const paths = this.dropPaths(e);
      if (!paths.length) return;
      e.preventDefault();
      e.stopPropagation();
      this.addFiles(paths);
    });
  }

  async pickFiles() {
    const res = await this.ctx.ui.filePicker({ mode: 'open', multiple: true, title: this.t('compose.attachTitle'), parent: this.ctx.win });
    if (!res) return;
    this.addFiles(Array.isArray(res) ? res : [res]);
  }

  async addFiles(paths) {
    const { api, ui } = this.ctx;
    for (const p of paths) {
      if (this.attachments.some((a) => a.path === p)) continue;
      try {
        const st = await api.invoke('fs:stat', p);
        if (st?.dir) {
          await ui.alert(this.t('compose.folderNotAllowed', { name: p.split('/').pop() }), { parent: this.ctx.win });
          continue;
        }
        this.attachments.push({ path: p, filename: p.split('/').pop(), size: st?.size || 0 });
      } catch (e) {
        await ui.alert(this.t('compose.attachFailed', { name: p.split('/').pop(), error: e.message }), { parent: this.ctx.win });
      }
    }
    this.markDirty();
    this.renderAttachments();
  }

  renderAttachments() {
    const { h, icon, ui, i18n } = this.ctx;
    const t = (k, v) => this.t(k, v);
    ui.clear(this.attachRow);
    this.attachRow.hidden = !this.attachments.length;
    let total = 0;
    for (const a of this.attachments) {
      total += a.size || 0;
      const k = fileKind(a.filename);
      this.attachRow.appendChild(
        h(
          'div',
          { class: 'ml-att', dataset: { name: a.filename }, title: a.filename },
          h('span', { class: 'ml-att-icon', style: { color: k.color } }, icon(k.icon, { size: 24 })),
          h('span', { class: 'ml-att-text' }, h('span', { class: 'ml-att-name ellipsis' }, a.filename), h('span', { class: 'caption text-2' }, i18n.formatSize(a.size || 0))),
          h('button', { class: 'btn subtle icon-btn small ml-att-x', 'aria-label': t('compose.removeAttachment', { name: a.filename }), 'data-tip': t('compose.removeAttachment', { name: a.filename }), onclick: () => this.removeAttachment(a) }, icon('dismiss', { size: 12 })),
        ),
      );
    }
    ui.clear(this.infobar);
    if (total > BIG_ATTACHMENTS) this.infobar.appendChild(h('div', { class: 'infobar warning' }, icon('warning', { filled: true }), h('div', { class: 'grow' }, t('compose.bigAttachments', { size: i18n.formatSize(total) }))));
  }

  removeAttachment(a) {
    this.attachments = this.attachments.filter((x) => x !== a);
    this.markDirty();
    this.renderAttachments();
  }

  // ------------------------------------------------------------ message
  bodyHtml() {
    if (this.plain) return null;
    const clone = this.editor.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    return `<div style="font-family: 'Segoe UI', Inter, Arial, sans-serif; font-size: 14px; line-height: 1.45">${clone.innerHTML}</div>`;
  }

  message() {
    const html = this.bodyHtml();
    return {
      to: this.to.value,
      cc: this.cc.value,
      bcc: this.bcc.value,
      subject: this.subject.value.trim(),
      html,
      text: this.plain ? this.textarea.value : htmlToText(html),
      attachments: this.attachments.map((a) => ({ path: a.path, filename: a.filename })),
      inReplyTo: this.inReplyTo,
      references: this.references,
      origin: this.origin,
      draft: this.draft,
    };
  }

  snapshot() {
    // Everything needed to rebuild this composer elsewhere (pop-out).
    return {
      accountId: this.accountId,
      mode: 'restore',
      to: this.to.value,
      cc: this.cc.value,
      bcc: this.bcc.value,
      subject: this.subject.value,
      html: this.plain ? null : this.editor.innerHTML,
      body: this.plain ? this.textarea.value : null,
      plain: this.plain,
      attachments: this.attachments,
      inReplyTo: this.inReplyTo,
      references: this.references,
      origin: this.origin,
      draft: this.draft,
      dirty: this.dirty,
    };
  }

  setBusy(on, label) {
    this.sending = on;
    this.el.classList.toggle('sending', on);
    this.sendBtn.disabled = on;
    this.sendBtn.querySelector('.lbl').textContent = on ? label || this.t('compose.sending') : this.t('compose.send');
    this.sendBtn.querySelector('.icon')?.classList.toggle('spin', on);
  }

  async send() {
    if (this.sending || this.closed) return;
    const { api, ui, h, icon } = this.ctx;
    const t = (k, v) => this.t(k, v);
    for (const f of [this.to, this.cc, this.bcc]) f.commit();
    const msg = this.message();
    const all = [...msg.to, ...msg.cc, ...msg.bcc];
    ui.clear(this.infobar);
    if (!this.account) {
      await ui.alert(t('compose.noAccount'), { parent: this.ctx.win });
      return;
    }
    if (!all.length) {
      this.infobar.appendChild(h('div', { class: 'infobar error', role: 'alert' }, icon('error_circle', { filled: true }), h('div', { class: 'grow' }, t('compose.needRecipient'))));
      this.to.focus();
      return;
    }
    const bad = all.filter((a) => !isEmail(a.address));
    if (bad.length) {
      await ui.alert(t('compose.badRecipients', { list: bad.map((a) => a.address).join(', ') }), { title: t('compose.checkNames'), parent: this.ctx.win });
      return;
    }
    if (!msg.subject && !(await ui.confirm(t('compose.noSubject'), { title: t('compose.noSubjectTitle'), okLabel: t('compose.sendAnyway'), cancelLabel: t('compose.dontSend'), parent: this.ctx.win }))) {
      this.subject.focus();
      return;
    }
    this.setBusy(true);
    try {
      await api.invoke('mail:send', this.accountId, msg);
      store.addContacts(all, 3);
      this.dirty = false;
      this.closed = true;
      this.cleanup();
      this.opts.onClose?.('sent', { accountId: this.accountId, folder: this.draft?.folder });
    } catch (e) {
      this.setBusy(false);
      const info = errorText(this.ctx.t, e, this.account?.smtp?.host);
      this.infobar.appendChild(
        h(
          'div',
          { class: 'infobar error ml-send-error', role: 'alert', dataset: { code: e.code || 'EFAIL' } },
          icon('error_circle', { filled: true }),
          h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, t('compose.sendFailed')), h('div', null, info.text), info.detail ? h('div', { class: 'caption text-2 selectable' }, info.detail) : null),
        ),
      );
    }
  }

  async saveDraft({ quiet = false } = {}) {
    if (this.sending) return false;
    const { api, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    for (const f of [this.to, this.cc, this.bcc]) f.commit();
    this.setBusy(true, t('compose.saving'));
    try {
      const res = await api.invoke('mail:saveDraft', this.accountId, this.message(), { replaceUid: this.draft?.uid || null });
      this.draft = res?.uid ? { folder: res.folder, uid: res.uid } : this.draft;
      this.dirty = false;
      this.status.textContent = t('compose.draftSaved', { time: this.ctx.i18n.formatTime(new Date(), { hour: 'numeric', minute: '2-digit' }) });
      this.status.dataset.saved = '1';
      return true;
    } catch (e) {
      if (!quiet) await ui.alert(`${t('compose.draftFailed')}\n${errorText(this.ctx.t, e).text}`, { parent: this.ctx.win });
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  async discard() {
    if (this.sending) return;
    const { ui, api } = this.ctx;
    const t = (k, v) => this.t(k, v);
    if (this.dirty || this.draft) {
      const ok = await ui.confirm(t('compose.discardConfirm'), { title: t('compose.discardTitle'), okLabel: t('compose.discard'), danger: true, parent: this.ctx.win });
      if (!ok) return;
    }
    if (this.draft?.uid) api.invoke('mail:delete', this.accountId, this.draft.folder, [this.draft.uid]).catch(() => {});
    this.dirty = false;
    this.closed = true;
    this.cleanup();
    this.opts.onClose?.('discard', { accountId: this.accountId, folder: this.draft?.folder });
  }

  // Ask about unsaved changes. Returns false if the user cancelled.
  async close({ silent = false } = {}) {
    if (this.closed) return true;
    if (this.sending) return false;
    if (this.dirty && !silent) {
      const { ui } = this.ctx;
      const t = (k, v) => this.t(k, v);
      const v = await ui.dialog({
        title: t('compose.unsavedTitle'),
        body: t('compose.unsavedText'),
        parent: this.ctx.win,
        buttons: [
          { label: t('compose.saveDraft'), value: 'save', primary: true },
          { label: t('compose.dontSave'), value: 'discard' },
          { label: t('common.cancel'), value: null },
        ],
      });
      if (v === null) return false;
      if (v === 'save' && !(await this.saveDraft())) return false;
    }
    this.closed = true;
    this.cleanup();
    this.opts.onClose?.('close', { accountId: this.accountId, folder: this.draft?.folder });
    return true;
  }

  popOut() {
    const snap = this.snapshot();
    this.closed = true;
    this.cleanup();
    this.opts.onClose?.('popout');
    this.ctx.shell.launch('mail', { newWindow: true, compose: snap });
  }

  cleanup() {
    document.removeEventListener('selectionchange', this.selHandler);
    for (const f of [this.to, this.cc, this.bcc]) f.closePopup();
  }

  onKey(e) {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'enter') {
      e.preventDefault();
      e.stopPropagation();
      this.send();
    } else if (e.ctrlKey && !e.shiftKey && k === 's') {
      e.preventDefault();
      e.stopPropagation();
      this.saveDraft();
    } else if (e.ctrlKey && e.shiftKey && k === 'b') {
      e.preventDefault();
      this.showField('bcc');
    } else if (e.ctrlKey && e.shiftKey && k === 'c') {
      e.preventDefault();
      this.showField('cc');
    }
  }
}
