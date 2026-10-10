// Account setup: provider tiles -> sign-in form (with advanced IMAP/SMTP settings) -> "Signing in…"
// -> "All done!". Also used to edit the server settings of an existing account.
//   const setup = new AccountSetup(ctx, { mode: 'first' | 'add' | 'edit', account, onDone(account), onCancel() });
//   container.appendChild(setup.el);
import { store } from './store.js';
import { isEmail } from './util.js';

const SECURITY = ['ssl', 'starttls', 'none'];
const isLocal = (host) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(String(host || '').trim());

export function errorText(t, e, fallbackHost) {
  const code = e?.code || 'EFAIL';
  const msg = String(e?.message || '');
  const side = e?.side || (/^smtp:/.test(msg) ? 'smtp' : /^imap:/.test(msg) ? 'imap' : null);
  const host = e?.host || fallbackHost || t('err.server');
  const detail = msg.replace(/^(imap|smtp):\s*/, '');
  // File system problems (saving an attachment, a file to send): the message is the file's path.
  if (['EACCES', 'ENOSPC', 'ENOENT'].includes(code)) {
    const name = detail.split('/').filter(Boolean).pop() || detail;
    return { title: null, text: t(`err.${code}`, { path: code === 'ENOENT' ? name : detail }), detail: null };
  }
  const known = ['EAUTH', 'ECONN', 'ETLS', 'ETIMEOUT', 'EINSECURE', 'EEXISTS', 'EINVAL', 'ENOACCOUNT', 'ENOMSG', 'ESERVER'];
  const text = known.includes(code) ? t(`err.${code}`, { host }) : t('err.EFAIL', { detail: detail || code });
  return { title: side ? t(`err.side.${side}`) : null, text, detail: known.includes(code) && !['EAUTH', 'EEXISTS', 'ENOMSG', 'ENOACCOUNT', 'ESERVER'].includes(code) ? detail : null };
}

export class AccountSetup {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.mode = opts.mode || 'first';
    const { h } = ctx;
    this.el = h('div', { class: ['ml-setup', `mode-${this.mode}`] });
    this.stage = h('div', { class: 'ml-setup-stage' });
    this.el.appendChild(this.stage);
    this.state = null;
    this.busy = false;
    if (this.mode === 'edit' && opts.account) this.showForm(opts.account.provider, opts.account);
    else this.showProviders();
  }

  t(k, v) {
    return this.ctx.t(k, v);
  }

  swap(node, dir = 'fwd') {
    const { ui } = this.ctx;
    // Keep keyboard focus inside the setup when the focused control is replaced (otherwise it falls
    // back to <body>, and Esc / Tab stop working in the settings dialog).
    const hadFocus = this.el.contains(document.activeElement) || document.activeElement === document.body;
    ui.clear(this.stage);
    node.classList.remove('enter', 'enter-back');
    node.classList.add('ml-step');
    if (dir !== 'none') node.classList.add(dir === 'back' ? 'enter-back' : 'enter');
    node.tabIndex = -1;
    this.stage.appendChild(node);
    if (hadFocus && this.el.isConnected) node.focus({ preventScroll: true });
    // Initial focus, unless the user already moved into the new step.
    setTimeout(() => {
      if (!node.isConnected) return;
      const a = document.activeElement;
      if (node.contains(a) && a !== node) return;
      const target = node.querySelector('[autofocus]:not(:disabled)');
      if (target) target.focus();
      else if (this.el.contains(a) || a === document.body) node.focus({ preventScroll: true });
    }, 60);
  }

  // Language switched: redraw the current step, keeping what was typed and the focused control.
  relocalize() {
    if (this.step === 'busy') {
      this.relocalizeLater = true;
      return;
    }
    const a = document.activeElement;
    const key = this.stage.contains(a) ? a.getAttribute('name') || a.dataset?.provider || null : null;
    if (this.step === 'providers') this.showProviders('none');
    else if (this.step === 'form') {
      const err = this.errorBox && !this.errorBox.hidden ? this.lastError : null;
      this.renderForm('none');
      if (err) this.showError(err.e, err.host);
    } else if (this.step === 'done' && this.doneAccount) this.showDone(this.doneAccount, 'none');
    if (key) this.stage.querySelector(`[name="${CSS.escape(key)}"], [data-provider="${CSS.escape(key)}"]`)?.focus();
  }

  // ------------------------------------------------------------ step 1: providers
  showProviders(dir) {
    const { h, icon } = this.ctx;
    const t = (k, v) => this.t(k, v);
    this.step = 'providers';
    const tiles = store.presets.map((p) =>
      h(
        'button',
        { class: 'ml-provider', dataset: { provider: p.id }, onclick: () => this.showForm(p.id) },
        this.monogram(p),
        h('span', { class: 'ml-provider-text' }, h('span', { class: 'ml-provider-name' }, p.id === 'other' ? t('setup.other') : p.name), h('span', { class: 'ml-provider-sub caption text-2' }, p.id === 'other' ? t('setup.otherSub') : p.sub)),
      ),
    );
    const step = h(
      'div',
      { class: 'ml-setup-providers' },
      this.mode === 'first'
        ? h('div', { class: 'ml-setup-hero' }, h('img', { src: this.ctx.appUrl('icon.svg'), alt: '', class: 'ml-setup-logo' }), h('div', { class: 'title' }, t('setup.welcome')), h('div', { class: 'body-large text-2' }, t('setup.welcomeSub')))
        : h('div', { class: 'ml-setup-head' }, h('div', { class: 'subtitle' }, t('setup.addTitle')), h('div', { class: 'text-2' }, t('setup.chooseProvider'))),
      h('div', { class: 'ml-provider-grid', role: 'list' }, tiles),
      h('div', { class: 'ml-setup-foot caption text-2' }, icon('lock_closed', { size: 14 }), h('span', null, store.storage.secure ? t('setup.privacy') : t('setup.privacyInsecure'))),
      this.mode !== 'first' ? h('div', { class: 'ml-setup-actions' }, h('button', { class: 'btn', onclick: () => this.opts.onCancel?.() }, t('common.cancel'))) : null,
    );
    this.swap(step, dir);
    if (dir === 'back') setTimeout(() => step.querySelector(`.ml-provider[data-provider="${this.provider?.id}"]`)?.focus(), 80);
  }

  monogram(p, size = 40) {
    const { h, icon } = this.ctx;
    return h(
      'span',
      { class: 'ml-mono', style: { backgroundColor: p.color, color: p.fg || '#fff', width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * (String(p.mono).length > 2 ? 0.3 : String(p.mono).length > 1 ? 0.38 : 0.48))}px` } },
      p.id === 'other' ? icon('mail', { size: Math.round(size * 0.5) }) : p.mono,
    );
  }

  // ------------------------------------------------------------ step 2: form
  showForm(providerId, account = null, dir) {
    const p = store.preset(providerId);
    const editing = !!account;
    this.provider = p;
    const s = (this.state = {
      provider: p.id,
      email: account?.email || '',
      name: account?.name || '',
      password: '',
      imap: { ...(account?.imap || p.imap || { host: '', port: 993, security: 'ssl' }), user: account?.imap?.user || '' },
      smtp: { ...(account?.smtp || p.smtp || { host: '', port: 465, security: 'ssl' }), user: account?.smtp?.user || '', password: '', sameAuth: account ? account.smtp.sameAuth : true },
      allowInsecure: false,
      trust: {},
      touched: { imap: editing, smtp: editing },
      advanced: p.manual || editing,
    });
    if (s.imap.user === s.email) s.imap.user = '';
    if (s.smtp.user === s.email || (s.smtp.sameAuth && s.smtp.user === s.imap.user)) s.smtp.user = '';
    this.renderForm(dir);
  }

  renderForm(dir) {
    const { h, icon, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const s = this.state;
    this.step = 'form';
    const p = this.provider;
    const editing = this.mode === 'edit';
    const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'field-hint' }, hint) : null);
    const bind = (input, get, set) => {
      input.value = get() ?? '';
      input.addEventListener('input', () => {
        set(input.value);
        this.validate();
      });
      return input;
    };
    const email = bind(h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'off', spellcheck: false, placeholder: t('setup.emailPlaceholder'), autofocus: !editing }), () => s.email, (v) => {
      s.email = v.trim();
      this.detect();
    });
    if (editing) email.disabled = true;
    const name = bind(h('input', { class: 'input', name: 'name', placeholder: t('setup.namePlaceholder') }), () => s.name, (v) => (s.name = v));
    const pass = bind(h('input', { class: 'input grow', type: 'password', name: 'password', autocomplete: 'off', placeholder: editing ? t('setup.keepPassword') : '', autofocus: editing }), () => s.password, (v) => (s.password = v));
    const reveal = h('button', { class: 'btn subtle icon-btn ml-reveal', type: 'button', 'aria-label': t('setup.showPassword'), 'data-tip': t('setup.showPassword') }, icon('eye'));
    reveal.addEventListener('click', () => {
      pass.type = pass.type === 'password' ? 'text' : 'password';
      ui.clear(reveal).appendChild(icon(pass.type === 'password' ? 'eye' : 'eye_off'));
    });
    const note = p.id !== 'other' || !editing ? this.t(`note.${p.id}`) : null;
    const help =
      note && note !== `note.${p.id}`
        ? h(
            'div',
            { class: 'infobar ml-help' },
            icon('info', { filled: true }),
            h(
              'div',
              { class: 'grow' },
              h('div', null, note),
              p.appPasswordUrl ? h('a', { href: '#', class: 'ml-link', onclick: (e) => (e.preventDefault(), this.ctx.shell.openUrl(p.appPasswordUrl)) }, t('setup.appPasswordLink'), ' ', icon('open', { size: 12 })) : null,
            ),
          )
        : null;

    // Advanced settings ------------------------------------------------
    const secSelect = (side) => {
      const sel = h('select', { class: 'select', name: `${side}-security` }, SECURITY.map((v) => h('option', { value: v, selected: s[side].security === v }, t(`sec.${v}`))));
      sel.addEventListener('change', () => {
        s[side].security = sel.value;
        s.touched[side] = true;
        const port = Number(s[side].port);
        const defaults = side === 'imap' ? { ssl: 993, starttls: 143, none: 143 } : { ssl: 465, starttls: 587, none: 25 };
        if ([993, 143, 465, 587, 25].includes(port) || !port) {
          s[side].port = defaults[sel.value];
          this.refs[`${side}Port`].value = s[side].port;
        }
        this.validate();
      });
      return sel;
    };
    const srv = (side, key, attrs = {}) => {
      const input = bind(h('input', { class: 'input', name: `${side}-${key}`, spellcheck: false, ...attrs }), () => s[side][key], (v) => {
        s[side][key] = key === 'port' ? Number(v) || '' : v.trim();
        s.touched[side] = true;
      });
      return input;
    };
    this.refs = {};
    const imapHost = srv('imap', 'host', { placeholder: 'imap.example.com' });
    const imapPort = (this.refs.imapPort = srv('imap', 'port', { type: 'number', min: 1, max: 65535 }));
    const imapUser = srv('imap', 'user', { placeholder: t('setup.sameAsEmail') });
    const smtpHost = srv('smtp', 'host', { placeholder: 'smtp.example.com' });
    const smtpPort = (this.refs.smtpPort = srv('smtp', 'port', { type: 'number', min: 1, max: 65535 }));
    const smtpUser = srv('smtp', 'user', { placeholder: t('setup.sameAsEmail') });
    const smtpPass = bind(h('input', { class: 'input', type: 'password', name: 'smtp-password', autocomplete: 'off', placeholder: editing ? t('setup.keepPassword') : '' }), () => s.smtp.password, (v) => (s.smtp.password = v));
    const smtpCreds = h('div', { class: 'ml-grid2', hidden: s.smtp.sameAuth }, field(t('setup.smtpUser'), smtpUser), field(t('setup.smtpPassword'), smtpPass));
    const same = ui.toggle({
      checked: s.smtp.sameAuth,
      label: t('setup.sameAuth'),
      onchange: (v) => {
        s.smtp.sameAuth = v;
        smtpCreds.hidden = v;
      },
    });
    this.refs.servers = { imapHost, imapPort, smtpHost, smtpPort };
    const insecureBox = h('div', { class: 'ml-insecure', hidden: true });
    this.refs.insecureBox = insecureBox;
    const advBody = h(
      'div',
      { class: 'ml-adv-body', hidden: !s.advanced },
      h('div', { class: 'ml-adv-title body-strong' }, t('setup.incoming')),
      h('div', { class: 'ml-grid3' }, field(t('setup.server'), imapHost), field(t('setup.port'), imapPort), field(t('setup.security'), secSelect('imap'))),
      field(t('setup.userName'), imapUser),
      h('div', { class: 'ml-adv-title body-strong' }, t('setup.outgoing')),
      h('div', { class: 'ml-grid3' }, field(t('setup.server'), smtpHost), field(t('setup.port'), smtpPort), field(t('setup.security'), secSelect('smtp'))),
      same,
      smtpCreds,
      insecureBox,
    );
    const advToggle = h(
      'button',
      { class: ['ml-expander', s.advanced && 'open'], type: 'button', 'aria-expanded': String(!!s.advanced), name: 'advanced' },
      icon('settings'),
      h('span', { class: 'grow' }, t('setup.advanced')),
      icon('chevron_down', { size: 12, class: 'chev' }),
    );
    advToggle.addEventListener('click', () => {
      s.advanced = !s.advanced;
      advBody.hidden = !s.advanced;
      advToggle.classList.toggle('open', s.advanced);
      advToggle.setAttribute('aria-expanded', String(s.advanced));
    });

    this.errorBox = h('div', { class: 'ml-error-box', hidden: true, role: 'alert' });
    this.submitBtn = h('button', { class: 'btn primary', type: 'submit', name: 'signin' }, editing ? t('common.save') : t('setup.signIn'));
    const back = h('button', { class: 'btn', type: 'button', onclick: () => (editing || this.mode === 'add-direct' ? this.opts.onCancel?.() : this.showProviders('back')) }, editing ? t('common.cancel') : t('setup.back'));
    const webmail = p.webmail && !editing ? h('a', { href: '#', class: 'ml-link ml-webmail', onclick: (e) => (e.preventDefault(), this.ctx.shell.openUrl(p.webmail)) }, icon('globe', { size: 14 }), t('setup.webmail')) : null;

    const form = h(
      'form',
      { class: 'ml-setup-form', autocomplete: 'off', novalidate: true },
      h(
        'div',
        { class: 'ml-form-head' },
        !editing ? h('button', { class: 'btn subtle icon-btn', type: 'button', 'aria-label': t('setup.back'), 'data-tip': t('setup.back'), onclick: () => this.showProviders('back') }, icon('arrow_left')) : null,
        this.monogram(p, 36),
        h('div', { class: 'grow' }, h('div', { class: 'subtitle' }, editing ? t('setup.editTitle') : p.id === 'other' ? t('setup.otherTitle') : t('setup.formTitle', { provider: p.name })), editing ? h('div', { class: 'text-2 caption' }, this.opts.account.email) : null),
      ),
      h('div', { class: 'ml-form-body' }, this.errorBox, field(t('setup.email'), email), field(t('setup.name'), name, t('setup.nameHint')), field(t('setup.password'), h('div', { class: 'ml-pass' }, pass, reveal)), help, advToggle, advBody),
      h('div', { class: 'ml-form-foot' }, webmail || h('span'), h('div', { class: 'ml-setup-actions' }, this.submitBtn, back)),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.form = form;
    this.swap(form, dir);
    this.validate();
  }

  // Fill server settings from the e-mail domain (known providers, Mozilla ISPDB, or a guess).
  detect() {
    clearTimeout(this.detectTimer);
    const s = this.state;
    if (!s || this.mode === 'edit') return;
    this.detectTimer = setTimeout(async () => {
      if (!isEmail(s.email)) return;
      const email = s.email;
      let res = null;
      try {
        res = await this.ctx.api.invoke('mail:autodetect', email);
      } catch {}
      if (!res || email !== s.email || !this.form?.isConnected) return;
      if (s.provider !== 'other' && res.provider !== s.provider) return;
      s.autoHost ||= {};
      for (const side of ['imap', 'smtp']) {
        if (s.touched[side] || !res[side]) continue;
        const r = this.refs.servers;
        // Never overwrite what the user is typing or typed.
        const typing = [r[`${side}Host`], r[`${side}Port`]].includes(document.activeElement);
        if (typing || (s[side].host && s[side].host !== s.autoHost[side] && s[side].host !== this.provider?.[side]?.host)) continue;
        Object.assign(s[side], { host: res[side].host, port: res[side].port, security: res[side].security });
        s.autoHost[side] = res[side].host;
        if (res[side].user === 'local') s[side].user = email.split('@')[0];
        r[`${side}Host`].value = s[side].host;
        r[`${side}Port`].value = s[side].port;
        const sel = this.form.querySelector(`select[name="${side}-security"]`);
        if (sel) sel.value = s[side].security;
      }
      this.validate();
    }, 350);
  }

  validate() {
    const s = this.state;
    if (!s || !this.submitBtn) return false;
    const { h, icon, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    // Unencrypted connections: fine to this computer, otherwise an explicit "I understand" is required.
    const plain = ['imap', 'smtp'].filter((side) => s[side].security === 'none');
    const remotePlain = plain.filter((side) => !isLocal(s[side].host));
    const box = this.refs.insecureBox;
    if (box) {
      ui.clear(box);
      box.hidden = !plain.length;
      if (remotePlain.length) {
        const cb = h('input', { type: 'checkbox', name: 'allow-insecure', checked: s.allowInsecure });
        cb.addEventListener('change', () => {
          s.allowInsecure = cb.checked;
          this.validate();
        });
        box.append(h('div', { class: 'infobar warning' }, icon('warning', { filled: true }), h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, t('setup.insecureTitle')), h('div', null, t('setup.insecureText')), h('label', { class: 'checkbox' }, cb, h('span', null, t('setup.insecureAccept'))))));
      } else if (plain.length) {
        box.append(h('div', { class: 'infobar' }, icon('info', { filled: true }), h('div', { class: 'grow' }, t('setup.localPlain'))));
      }
    }
    const ok =
      (this.mode === 'edit' || (isEmail(s.email) && s.password.length > 0)) &&
      s.imap.host &&
      s.smtp.host &&
      Number(s.imap.port) > 0 &&
      Number(s.smtp.port) > 0 &&
      (!remotePlain.length || s.allowInsecure) &&
      (s.smtp.sameAuth || this.mode === 'edit' || s.smtp.password.length > 0);
    this.submitBtn.disabled = !ok || this.busy;
    return ok;
  }

  showError(e, host) {
    const { h, icon, ui } = this.ctx;
    this.lastError = { e, host };
    const info = errorText(this.ctx.t, e, host);
    ui.clear(this.errorBox);
    this.errorBox.hidden = false;
    this.errorBox.append(
      h(
        'div',
        { class: 'infobar error' },
        icon('error_circle', { filled: true }),
        h(
          'div',
          { class: 'grow' },
          info.title ? h('div', { class: 'body-strong' }, info.title) : null,
          h('div', { class: 'ml-error-text' }, info.text),
          e?.code === 'EAUTH' && this.provider?.appPasswordUrl ? h('div', { class: 'caption' }, this.t('setup.authHint')) : null,
          info.detail ? h('div', { class: 'caption text-2 selectable' }, info.detail) : null,
        ),
      ),
    );
    this.errorBox.dataset.code = e?.code || 'EFAIL';
    this.errorBox.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  config() {
    const s = this.state;
    const server = (side) => ({ host: s[side].host, port: Number(s[side].port), security: s[side].security, user: s[side].user || '' });
    const cfg = {
      email: s.email,
      name: s.name.trim(),
      provider: s.provider,
      password: s.password,
      imap: server('imap'),
      smtp: { ...server('smtp'), sameAuth: s.smtp.sameAuth, password: s.smtp.sameAuth ? undefined : s.smtp.password },
      allowInsecure: s.allowInsecure,
      trust: { ...s.trust },
    };
    if (!Object.keys(cfg.trust).length) delete cfg.trust;
    return cfg;
  }

  // ------------------------------------------------------------ step 3: signing in
  async submit() {
    if (this.busy || !this.validate()) return;
    const { h, api } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const s = this.state;
    if (!s.name.trim() && this.mode !== 'edit') s.name = s.email.split('@')[0];
    this.busy = true;
    const formNode = this.form;
    const busyStep = h('div', { class: 'ml-setup-busy', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'spinner' }), h('div', { class: 'subtitle' }, this.mode === 'edit' ? t('setup.checking') : t('setup.signingIn')), h('div', { class: 'text-2' }, t('setup.connecting', { host: s.imap.host })));
    this.swap(busyStep);
    this.step = 'busy';
    try {
      const cfg = this.config();
      const test = await api.invoke('mail:testAccount', this.mode === 'edit' ? { ...cfg, id: this.opts.account.id, password: cfg.password || undefined } : cfg);
      if (!test.ok) {
        const e = test.error;
        if (e.code === 'ETLS' && e.cert && !s.trust[e.side]) {
          const trusted = await this.askTrust(e);
          if (trusted) {
            s.trust[e.side] = e.cert.pem;
            this.busy = false;
            return this.submit();
          }
        }
        throw Object.assign(new Error(`${e.side}: ${e.message}`), { code: e.code, side: e.side, host: e.host });
      }
      let account;
      if (this.mode === 'edit') {
        const patch = { ...cfg, skipTest: true };
        if (!patch.password) delete patch.password;
        if (patch.smtp && !patch.smtp.password) delete patch.smtp.password;
        delete patch.email;
        account = await api.invoke('mail:updateAccount', this.opts.account.id, patch);
      } else {
        account = await api.invoke('mail:addAccount', { ...cfg, skipTest: true });
      }
      await store.loadAccounts();
      this.busy = false;
      this.relocalizeLater = false;
      if (this.mode === 'edit') return this.opts.onDone?.(account);
      this.showDone(account);
    } catch (e) {
      this.busy = false;
      this.step = 'form';
      // The language may have changed while signing in: rebuild the form instead of reusing it.
      if (this.relocalizeLater) this.renderForm('back');
      else this.swap(formNode, 'back');
      this.relocalizeLater = false;
      this.validate();
      this.showError(e, s.imap.host);
    }
  }

  async askTrust(e) {
    const { h, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const c = e.cert;
    const row = (k, v) => h('div', { class: 'ml-cert-row' }, h('span', { class: 'text-2' }, k), h('span', { class: 'selectable mono-ish' }, v || '—'));
    const body = h(
      'div',
      { class: 'ml-cert' },
      h('div', null, t('cert.text', { host: e.host })),
      h('div', { class: 'ml-cert-box' }, row(t('cert.issuedTo'), c.subject), row(t('cert.issuedBy'), c.issuer), row(t('cert.validUntil'), c.validTo), row('SHA-256', c.fingerprint)),
      h('div', { class: 'caption text-2' }, t(isLocal(e.host) ? 'cert.localHint' : 'cert.remoteHint')),
    );
    const v = await ui.dialog({
      title: t('cert.title'),
      body,
      parent: this.ctx.win,
      buttons: [
        { label: t('cert.trust'), value: 'trust', primary: isLocal(e.host) },
        { label: t('common.cancel'), value: null, primary: !isLocal(e.host) },
      ],
    });
    return v === 'trust';
  }

  // ------------------------------------------------------------ step 4: done
  showDone(account, dir) {
    const { h, icon } = this.ctx;
    const t = (k, v) => this.t(k, v);
    this.step = 'done';
    this.doneAccount = account;
    const done = h('button', { class: 'btn primary', name: 'done', autofocus: true, onclick: () => this.opts.onDone?.(account) }, t('setup.done'));
    const step = h(
      'div',
      { class: 'ml-setup-done' },
      h('div', { class: 'ml-done-mark' }, icon('checkmark_circle', { size: 56, filled: true })),
      h('div', { class: 'title' }, t('setup.allDone')),
      h('div', { class: 'body-large text-2' }, t('setup.successText')),
      h('div', { class: 'ml-done-account' }, this.monogram(store.preset(account.provider), 32), h('div', null, h('div', { class: 'body-strong' }, account.name || account.email), h('div', { class: 'caption text-2' }, account.email))),
      account.insecureStorage ? h('div', { class: 'infobar warning ml-done-warning' }, icon('warning', { filled: true }), h('div', { class: 'grow caption' }, t('settings.insecureStorage'))) : null,
      h('div', { class: 'ml-setup-actions' }, done),
    );
    this.swap(step, dir);
  }
}
