// Search flyout (the bar's search button, Win+S): a search field over one results list grouped by kind
//   (Applications, Fichiers, Réglages, Web), the best group first and its first result selected; a preview pane on the
//   right only for an app or a file (Open / Pin; Open / Open file location / Copy path). Empty: recent items and
//   common settings as one list. Keys: Up/Down move, Enter opens, Ctrl+Tab / Alt+Left/Right narrow to one kind.
//   Shell events: 'search:toggle', 'search:open' ({ query }), 'search:close'.
import { createFlyout } from '../taskbar.js';
import { SearchView } from '../start.js';

let ctx;
let fly;
let root;
let input;
let sv;

const STRINGS = {
  en: { searchPanel: { title: 'Search', placeholder: 'Search for an app, a file or a setting', clear: 'Clear' } },
  fr: { searchPanel: { title: 'Rechercher', placeholder: 'Rechercher une application, un fichier ou un réglage', clear: 'Effacer' } },
};

function render() {
  const { h, t } = ctx;
  const icon = ctx.ui.icon;
  input = h('input', {
    class: 'sp-input',
    type: 'text',
    spellcheck: false,
    placeholder: t('searchPanel.placeholder'),
    'aria-label': t('searchPanel.title'),
    oninput: () => {
      clearBtn.hidden = !input.value;
      sv.setQuery(input.value);
    },
  });
  const clearBtn = h(
    'button',
    {
      class: 'sp-clear',
      hidden: true,
      'aria-label': t('searchPanel.clear'),
      onclick: () => {
        input.value = '';
        clearBtn.hidden = true;
        sv.setQuery('');
        input.focus();
      },
    },
    icon('dismiss', { size: 12 }),
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), sv.move(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), sv.move(-1));
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (!input.value.trim() && !sv.hasSelection()) return;
      sv.activate();
    } else if ((e.key === 'Tab' && e.ctrlKey) || (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'))) {
      e.preventDefault();
      const cats = ['all', 'apps', 'documents', 'settings', 'web'];
      const dir = e.shiftKey || e.key === 'ArrowLeft' ? -1 : 1;
      sv.setCategory(cats[(cats.indexOf(sv.cat) + dir + cats.length) % cats.length]);
    }
  });
  sv = new SearchView({ variant: 'panel', onDone: () => fly.close('launch') });
  // Picking a category with the mouse keeps typing / arrow keys in the search box.
  sv.onCategory = () => input.focus({ preventScroll: true });
  sv.onPickRecent = (q) => {
    input.value = q;
    clearBtn.hidden = false;
    sv.setQuery(q);
    input.focus();
  };
  root.replaceChildren(h('div', { class: 'sp-top' }, h('div', { class: 'sp-box' }, icon('magnifying-glass', { size: 18 }), input, clearBtn)), h('div', { class: 'sp-body' }, sv.el));
  sv.setQuery('');
}

export function mount(c) {
  ctx = c;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/search.css');
  root = ctx.h('div', { id: 'search-panel', class: 'sp', role: 'dialog', 'aria-label': ctx.t('searchPanel.title') });
  document.getElementById('flyouts').appendChild(root);
  render();
  fly = createFlyout({
    id: 'search',
    el: root,
    button: '.tb-search',
    focus: () => input,
    onOpen: (opts) => {
      const q = typeof opts?.query === 'string' ? opts.query : '';
      input.value = q;
      root.querySelector('.sp-clear').hidden = !q;
      if (sv.cat !== 'all') sv.setCategory('all');
      sv.setQuery(q);
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(q.length, q.length);
      }, 30);
    },
  });
  ctx.shell.on('search:toggle', () => fly.toggle());
  ctx.shell.on('search:open', (opts) => {
    if (fly.isOpen) {
      if (typeof opts?.query === 'string') {
        input.value = opts.query;
        root.querySelector('.sp-clear').hidden = !opts.query;
        sv.setQuery(opts.query);
        input.focus();
      }
      return;
    }
    fly.open(opts || {});
  });
  ctx.shell.on('search:close', () => fly.close('event'));
  ctx.i18n.on('change', () => {
    root.setAttribute('aria-label', ctx.t('searchPanel.title'));
    render();
  });
  c.search = {
    open: (query) => fly.open({ query }),
    close: () => fly.close('api'),
    get isOpen() {
      return fly.isOpen;
    },
    get view() {
      return sv;
    },
  };
}
