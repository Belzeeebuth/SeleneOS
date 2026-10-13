// Office documents (.docx .doc .xlsx .xls .pptx .ppt .odt .ods .odp .rtf) when nothing can open them (Fichiers,
// Courrier attachments, aurora-open): « Pour ouvrir ce document, installez LibreOffice » -> « Installer » installs
// LibreOffice from Flathub through the Logithèque's own path (store:install, per user, no admin password; progress
// notification like the gaming setup), then opens the document. Once installed, registry.handlerFor() finds it by
// MIME type (Linux apps declare MIME types, not extensions).
import { api } from '../api.js';
import { i18n, t } from '../i18n.js';
import { registry } from '../registry.js';
import { notify, notifications } from '../notify.js';
import { ui, h } from '../ui.js';

export const LIBREOFFICE = { source: 'flathub', id: 'org.libreoffice.LibreOffice' };
export const OFFICE_MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
};

i18n.extend({
  en: {
    office: {
      title: 'To open this document, install LibreOffice',
      body: '“{name}” is an office document. LibreOffice is free: it opens and edits texts, spreadsheets and presentations (Word, Excel, PowerPoint, OpenDocument). It installs from the Logithèque in a few minutes.',
      install: 'Install',
      cancel: 'Not now',
      progress: 'Installing LibreOffice…',
      progressBody: 'Your document will open when it is ready.',
      failed: 'LibreOffice could not be installed',
      openStore: 'Open the Logithèque',
      notFound: 'LibreOffice is installed, but your document could not be opened. Try again from Files.',
    },
  },
  fr: {
    office: {
      title: 'Pour ouvrir ce document, installez LibreOffice',
      body: '« {name} » est un document bureautique. LibreOffice est gratuit : il ouvre et modifie les textes, tableurs et présentations (Word, Excel, PowerPoint, OpenDocument). Il s’installe depuis la Logithèque en quelques minutes.',
      install: 'Installer',
      cancel: 'Plus tard',
      progress: 'Installation de LibreOffice…',
      progressBody: 'Votre document s’ouvrira dès qu’il sera prêt.',
      failed: 'LibreOffice n’a pas pu être installé',
      openStore: 'Ouvrir la Logithèque',
      notFound: 'LibreOffice est installé, mais votre document n’a pas pu s’ouvrir. Réessayez depuis Fichiers.',
    },
  },
});

const extOf = (p) => (/\.[^./]+$/.exec(p || '')?.[0] || '').toLowerCase();
export const isOffice = (p) => Object.hasOwn(OFFICE_MIME, extOf(p));

let installing = null; // one install at a time; documents asked meanwhile open when it ends
const waiting = new Set();

async function waitForHandler(path, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await registry.load().catch(() => {});
    const id = registry.handlerFor(path);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function install(path) {
  waiting.add(path);
  if (installing) return installing;
  const nid = notify({ appId: 'store', icon: 'document', title: t('office.progress'), body: t('office.progressBody'), progress: 'indeterminate', timeout: 0, silent: true });
  const off = api.on('store:progress', (p) => {
    if (p?.source === LIBREOFFICE.source && p?.id === LIBREOFFICE.id && typeof p.percent === 'number') notifications.update(nid, { progress: Math.max(0, Math.min(100, p.percent)) });
  });
  installing = (async () => {
    try {
      await api.invoke('store:install', LIBREOFFICE.source, LIBREOFFICE.id);
      notifications.dismiss(nid);
      for (const p of [...waiting]) {
        const id = await waitForHandler(p);
        if (id) await registry.openFile(p, { appId: id });
        else notify({ appId: 'store', icon: 'warning', title: t('office.title'), body: t('office.notFound') });
      }
    } catch (err) {
      notifications.dismiss(nid);
      if (err?.code !== 'ECANCELED') {
        notify({
          appId: 'store',
          icon: 'warning',
          title: t('office.failed'),
          body: String(err?.message || err),
          actions: [{ label: t('office.openStore'), onClick: () => registry.launch('store', { id: LIBREOFFICE.id }) }],
        });
      }
    } finally {
      off?.();
      waiting.clear();
      installing = null;
    }
  })();
  return installing;
}

/** The prompt; resolves when it is answered (true = install started). */
export async function prompt(path, { parent } = {}) {
  const name = String(path).split('/').pop();
  if (installing) {
    waiting.add(path);
    return true;
  }
  const body = h('div', { class: 'office-prompt' }, h('p', { class: 'body' }, t('office.body', { name })));
  const answer = await ui.dialog({
    title: t('office.title'),
    body,
    parent,
    width: 460,
    className: 'office-dialog',
    buttons: [
      { label: t('office.cancel'), value: false },
      { label: t('office.install'), value: true, primary: true },
    ],
  });
  if (!answer) return false;
  install(path);
  return true;
}

export function mount() {}
