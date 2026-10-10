// Localization adapter for the pdf.js viewer components (pdf_viewer.mjs).
// pdf.js marks the DOM it builds with data-l10n-id / data-l10n-args (page landmarks, the annotation
// editor toolbars, colour pickers, screen-reader alerts…) and expects an L10n object that fills them
// in. The stock GenericL10n only knows English, so this one translates the ids pdf.js actually uses
// into English and French, follows the shell language, and watches its roots for new elements.
import { i18n } from '../../../core/i18n.js';

// id -> { en, fr } ; each entry is { value } and/or { attrs: { name: text } }. {arg} placeholders.
const M = {
  'pdfjs-page-landmark': { en: { attrs: { 'aria-label': 'Page {page}' } }, fr: { attrs: { 'aria-label': 'Page {page}' } } },
  'pdfjs-free-text2': {
    en: { attrs: { 'aria-label': 'Text editor', 'default-content': 'Start typing…' } },
    fr: { attrs: { 'aria-label': 'Éditeur de texte', 'default-content': 'Commencez à écrire…' } },
  },
  'pdfjs-editor-remove-ink-button': { en: { attrs: { title: 'Remove drawing' } }, fr: { attrs: { title: 'Supprimer le dessin' } } },
  'pdfjs-editor-remove-freetext-button': { en: { attrs: { title: 'Remove text' } }, fr: { attrs: { title: 'Supprimer le texte' } } },
  'pdfjs-editor-remove-stamp-button': { en: { attrs: { title: 'Remove image' } }, fr: { attrs: { title: 'Supprimer l’image' } } },
  'pdfjs-editor-remove-highlight-button': { en: { attrs: { title: 'Remove highlight' } }, fr: { attrs: { title: 'Supprimer le surlignage' } } },
  'pdfjs-editor-remove-signature-button': { en: { attrs: { title: 'Remove signature' } }, fr: { attrs: { title: 'Supprimer la signature' } } },
  'pdfjs-editor-highlight-editor': { en: { attrs: { 'aria-label': 'Highlight' } }, fr: { attrs: { 'aria-label': 'Surlignage' } } },
  'pdfjs-editor-ink-editor': { en: { attrs: { 'aria-label': 'Drawing' } }, fr: { attrs: { 'aria-label': 'Dessin' } } },
  'pdfjs-editor-stamp-editor': { en: { attrs: { 'aria-label': 'Image' } }, fr: { attrs: { 'aria-label': 'Image' } } },
  'pdfjs-editor-signature-editor1': { en: { attrs: { 'aria-description': 'Signature: {description}' } }, fr: { attrs: { 'aria-description': 'Signature : {description}' } } },
  'pdfjs-editor-resizer-top-left': { en: { attrs: { 'aria-label': 'Top left corner — resize' } }, fr: { attrs: { 'aria-label': 'Coin supérieur gauche — redimensionner' } } },
  'pdfjs-editor-resizer-top-middle': { en: { attrs: { 'aria-label': 'Top middle — resize' } }, fr: { attrs: { 'aria-label': 'Milieu haut — redimensionner' } } },
  'pdfjs-editor-resizer-top-right': { en: { attrs: { 'aria-label': 'Top right corner — resize' } }, fr: { attrs: { 'aria-label': 'Coin supérieur droit — redimensionner' } } },
  'pdfjs-editor-resizer-middle-right': { en: { attrs: { 'aria-label': 'Middle right — resize' } }, fr: { attrs: { 'aria-label': 'Milieu droit — redimensionner' } } },
  'pdfjs-editor-resizer-bottom-right': { en: { attrs: { 'aria-label': 'Bottom right corner — resize' } }, fr: { attrs: { 'aria-label': 'Coin inférieur droit — redimensionner' } } },
  'pdfjs-editor-resizer-bottom-middle': { en: { attrs: { 'aria-label': 'Bottom middle — resize' } }, fr: { attrs: { 'aria-label': 'Milieu bas — redimensionner' } } },
  'pdfjs-editor-resizer-bottom-left': { en: { attrs: { 'aria-label': 'Bottom left corner — resize' } }, fr: { attrs: { 'aria-label': 'Coin inférieur gauche — redimensionner' } } },
  'pdfjs-editor-resizer-middle-left': { en: { attrs: { 'aria-label': 'Middle left — resize' } }, fr: { attrs: { 'aria-label': 'Milieu gauche — redimensionner' } } },
  'pdfjs-editor-colorpicker-button': { en: { attrs: { title: 'Change color' } }, fr: { attrs: { title: 'Changer la couleur' } } },
  'pdfjs-editor-colorpicker-dropdown': { en: { attrs: { 'aria-label': 'Color choices' } }, fr: { attrs: { 'aria-label': 'Choix de couleurs' } } },
  'pdfjs-editor-colorpicker-yellow': { en: { attrs: { title: 'Yellow' } }, fr: { attrs: { title: 'Jaune' } } },
  'pdfjs-editor-colorpicker-green': { en: { attrs: { title: 'Green' } }, fr: { attrs: { title: 'Vert' } } },
  'pdfjs-editor-colorpicker-blue': { en: { attrs: { title: 'Blue' } }, fr: { attrs: { title: 'Bleu' } } },
  'pdfjs-editor-colorpicker-pink': { en: { attrs: { title: 'Pink' } }, fr: { attrs: { title: 'Rose' } } },
  'pdfjs-editor-colorpicker-red': { en: { attrs: { title: 'Red' } }, fr: { attrs: { title: 'Rouge' } } },
  'pdfjs-editor-color-picker-ink-input': { en: { attrs: { title: 'Change drawing color' } }, fr: { attrs: { title: 'Changer la couleur du dessin' } } },
  'pdfjs-editor-color-picker-free-text-input': { en: { attrs: { title: 'Change text color' } }, fr: { attrs: { title: 'Changer la couleur du texte' } } },
  'pdfjs-editor-highlight-added-alert': { en: { value: 'Highlight added' }, fr: { value: 'Surlignage ajouté' } },
  'pdfjs-editor-freetext-added-alert': { en: { value: 'Text added' }, fr: { value: 'Texte ajouté' } },
  'pdfjs-editor-ink-added-alert': { en: { value: 'Drawing added' }, fr: { value: 'Dessin ajouté' } },
  'pdfjs-editor-stamp-added-alert': { en: { value: 'Image added' }, fr: { value: 'Image ajoutée' } },
  'pdfjs-editor-signature-added-alert': { en: { value: 'Signature added' }, fr: { value: 'Signature ajoutée' } },
  'pdfjs-editor-alt-text-button': { en: { attrs: { 'aria-label': 'Alt text' } }, fr: { attrs: { 'aria-label': 'Texte alternatif' } } },
  'pdfjs-editor-alt-text-button-label': { en: { value: 'Alt text' }, fr: { value: 'Texte alternatif' } },
  'pdfjs-editor-alt-text-edit-button': { en: { attrs: { 'aria-label': 'Edit alt text' } }, fr: { attrs: { 'aria-label': 'Modifier le texte alternatif' } } },
  'pdfjs-editor-alt-text-decorative-tooltip': { en: { value: 'Marked as decorative' }, fr: { value: 'Marquée comme décorative' } },
  'pdfjs-editor-new-alt-text-added-button': { en: { attrs: { 'aria-label': 'Alt text added' } }, fr: { attrs: { 'aria-label': 'Texte alternatif ajouté' } } },
  'pdfjs-editor-new-alt-text-added-button-label': { en: { value: 'Alt text added' }, fr: { value: 'Texte alternatif ajouté' } },
  'pdfjs-editor-new-alt-text-missing-button': { en: { attrs: { 'aria-label': 'Missing alt text' } }, fr: { attrs: { 'aria-label': 'Texte alternatif manquant' } } },
  'pdfjs-editor-new-alt-text-missing-button-label': { en: { value: 'Missing alt text' }, fr: { value: 'Texte alternatif manquant' } },
  'pdfjs-editor-new-alt-text-to-review-button': { en: { attrs: { 'aria-label': 'Review alt text' } }, fr: { attrs: { 'aria-label': 'Vérifier le texte alternatif' } } },
  'pdfjs-editor-new-alt-text-to-review-button-label': { en: { value: 'Review alt text' }, fr: { value: 'Vérifier le texte alternatif' } },
  'pdfjs-editor-new-alt-text-generated-alt-text-with-disclaimer': { en: { value: 'Created automatically: {generatedAltText}' }, fr: { value: 'Créé automatiquement : {generatedAltText}' } },
  'pdfjs-show-comment-button': { en: { attrs: { title: 'Show comment' } }, fr: { attrs: { title: 'Afficher le commentaire' } } },
  'pdfjs-editor-add-comment-button': { en: { attrs: { title: 'Add comment' } }, fr: { attrs: { title: 'Ajouter un commentaire' } } },
  'pdfjs-highlight-floating-button-label': { en: { value: 'Highlight' }, fr: { value: 'Surligner' } },
  'pdfjs-comment-floating-button-label': { en: { value: 'Comment' }, fr: { value: 'Commenter' } },
  'pdfjs-text-annotation-type': { en: { attrs: { alt: '[{type} annotation]' } }, fr: { attrs: { alt: '[Annotation {type}]' } } },
  'pdfjs-annotation-date-time-string': { en: { value: '{dateObj}' }, fr: { value: '{dateObj}' } },
};

function lang() {
  return i18n.lang === 'fr' ? 'fr' : 'en';
}

function fill(str, args) {
  if (!args) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => {
    if (args[k] === undefined) return m;
    if (k === 'dateObj') {
      try {
        return i18n.formatDate(new Date(args[k]), { dateStyle: 'short', timeStyle: 'medium' });
      } catch {
        return '';
      }
    }
    return String(args[k]);
  });
}

function message(id, args) {
  const entry = M[id];
  if (!entry) return null;
  const m = entry[lang()] || entry.en;
  return {
    value: m.value != null ? fill(m.value, args) : null,
    attrs: m.attrs ? Object.fromEntries(Object.entries(m.attrs).map(([k, v]) => [k, fill(v, args)])) : null,
  };
}

function parseArgs(el) {
  const raw = el.getAttribute('data-l10n-args');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function translateElement(el) {
  const id = el.getAttribute('data-l10n-id');
  if (!id) return;
  const msg = message(id, parseArgs(el));
  if (!msg) return;
  if (msg.value != null && !el.firstElementChild && el.textContent !== msg.value) el.textContent = msg.value;
  if (msg.attrs) for (const [k, v] of Object.entries(msg.attrs)) if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}

function translateTree(root) {
  if (root.nodeType !== 1) return;
  if (root.hasAttribute('data-l10n-id')) translateElement(root);
  for (const el of root.querySelectorAll('[data-l10n-id]')) translateElement(el);
}

/** Implements the interface pdf.js expects from its L10n class (web/l10n.js). */
export class AuroraL10n {
  #roots = new Set();
  #paused = 0;
  #observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') translateElement(m.target);
      else for (const n of m.addedNodes) translateTree(n);
    }
  });

  constructor() {
    i18n.on('change', () => this.#retranslate());
  }
  getLanguage() {
    return lang() === 'fr' ? 'fr' : 'en-us';
  }
  getDirection() {
    return 'ltr';
  }
  async get(ids, args = null) {
    if (Array.isArray(ids)) return ids.map((id) => message(id)?.value ?? '');
    return message(ids, args)?.value ?? '';
  }
  async translate(element) {
    if (!element) return;
    this.#roots.add(element);
    translateTree(element);
    if (!this.#paused) this.#observe(element);
  }
  async translateOnce(element) {
    if (element) translateTree(element);
  }
  async destroy() {
    // Shared by every viewer: nothing global to tear down. Roots go away with their viewers.
  }
  /** Stop watching a root (a closed document). */
  forget(element) {
    this.#roots.delete(element);
    this.#reconnect();
  }
  pause() {
    if (this.#paused++ === 0) this.#observer.disconnect();
  }
  resume() {
    if (this.#paused === 0) return;
    if (--this.#paused === 0) {
      for (const r of this.#roots) translateTree(r);
      this.#reconnect();
    }
  }
  #observe(root) {
    this.#observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-l10n-id', 'data-l10n-args'] });
  }
  #reconnect() {
    this.#observer.disconnect();
    if (this.#paused) return;
    for (const r of [...this.#roots]) {
      if (r.isConnected || r.parentNode) this.#observe(r);
      else this.#roots.delete(r);
    }
  }
  #retranslate() {
    for (const r of this.#roots) translateTree(r);
  }
}
