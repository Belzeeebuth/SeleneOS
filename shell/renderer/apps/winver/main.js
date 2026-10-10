// Reference app: shows the minimal structure every Aurora app follows.
export default {
  async launch(ctx) {
    const { h, t, win, api } = ctx;
    const info = await api.invoke('sys:info');
    win.body.appendChild(
      h('div', { class: 'winver' },
        h('div', { class: 'winver-brand' },
          h('img', { src: ctx.appUrl('icon.svg'), alt: '' }),
          h('div', null, h('div', { class: 'title' }, 'Aurora OS'), h('div', { class: 'text-2' }, info.distro))),
        h('hr', { class: 'hsep' }),
        h('div', null, t('version', { v: info.version }), ' · ', t('build', { b: info.buildId })),
        h('div', { class: 'text-2' }, t('kernel', { k: info.kernel })),
        h('div', { class: 'caption text-2' }, t('license')),
        h('div', null, t('user'), ' ', h('b', null, info.fullName)),
        h('div', { class: 'footer' }, h('button', { class: 'btn primary', style: { minWidth: '120px' }, onclick: () => win.close() }, t('common.ok'))),
      ),
    );
  },
};
