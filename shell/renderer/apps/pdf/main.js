const BASE = 'app://shell/node_modules/pdfjs-dist/';
export default {
  async launch(ctx) {
    const { win, h, api } = ctx;
    const lib = await import(`${BASE}build/pdf.mjs`);
    const v = await import(`${BASE}web/pdf_viewer.mjs`);
    lib.GlobalWorkerOptions.workerSrc = `${BASE}build/pdf.worker.mjs`;
    const css = await (await fetch(`${BASE}web/pdf_viewer.css`)).text();
    const scoped = `@scope (.pdf-host) {\n${css.replace(/:root/g, ':scope').replace(/url\((["']?)images\//g, `url($1${BASE}web/images/`)}\n}`;
    document.head.appendChild(h('style', { text: scoped }));
    const viewerDiv = h('div', { class: 'pdfViewer' });
    const container = h('div', { class: 'pdf-host', style: { position: 'absolute', inset: '0', overflow: 'auto' } }, viewerDiv);
    win.body.appendChild(h('div', { style: { position: 'relative', flex: '1' } }, container));
    const eventBus = new v.EventBus();
    const linkService = new v.PDFLinkService({ eventBus });
    const findController = new v.PDFFindController({ eventBus, linkService });
    const viewer = new v.PDFViewer({ container, viewer: viewerDiv, eventBus, linkService, findController, annotationEditorMode: lib.AnnotationEditorType.NONE });
    linkService.setViewer(viewer);
    window.__pdfproto = { lib, v, viewer, eventBus, findController };
    const file = ctx.args.file;
    if (file) {
      const data = await api.invoke('fs:readBytes', file);
      const task = lib.getDocument({ data, cMapUrl: `${BASE}cmaps/`, standardFontDataUrl: `${BASE}standard_fonts/`, wasmUrl: `${BASE}wasm/`, iccUrl: `${BASE}iccs/` });
      task.onPassword = (cb, reason) => { console.log('password needed', reason); cb('secret'); };
      const doc = await task.promise;
      viewer.setDocument(doc);
      linkService.setDocument(doc);
      eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; });
      window.__pdfproto.doc = doc;
    }
  },
};
