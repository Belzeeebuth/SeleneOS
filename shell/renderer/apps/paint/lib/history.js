// Undo / redo for the Paint document.
//
// Memory-conscious: a step stores only the pixels it is about to change (a region diff), or a
// copy of the whole image for operations that change its size (resize, rotate, crop…).
// Undo and redo *swap* the stored pixels with the current ones, so one buffer serves both
// directions. When raw buffers exceed a budget, older steps are compressed to PNG blobs in
// the background and decoded again on demand.
//
//   const hist = new History(doc, { onChange })
//   hist.recordRegion({x, y, w, h})   // BEFORE drawing into that area
//   hist.pushRegionData(rect, imageData)  // when the "before" pixels were captured earlier
//   hist.recordFull()                 // BEFORE an operation that replaces the whole image
//   await hist.undo() / await hist.redo()
//   hist.state                        // id of the current state (compare with a saved id for "dirty")
//
// `doc` must provide { canvas, ctx, resize(w, h) }.

export function clipRect(r, w, h) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(w, Math.ceil(r.x + r.w));
  const y2 = Math.min(h, Math.ceil(r.y + r.h));
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

export function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export class History {
  constructor(doc, { limit = 100, budget = 160 * 1024 * 1024, keepRaw = 4, onChange } = {}) {
    this.doc = doc;
    this.limit = limit;
    this.budget = budget;
    this.keepRaw = keepRaw;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
    this.seq = 0;
    this.queue = Promise.resolve();
    this._timer = null;
  }

  get state() {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].id : 0;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get length() {
    return this.undoStack.length;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange?.();
  }

  recordRegion(rect) {
    const r = clipRect(rect, this.doc.canvas.width, this.doc.canvas.height);
    if (!r) return null;
    return this.pushRegionData(r, this.doc.ctx.getImageData(r.x, r.y, r.w, r.h));
  }

  pushRegionData(rect, data) {
    return this._push({ kind: 'region', rect: { ...rect }, data, bytes: data.data.length });
  }

  recordFull() {
    const c = cloneCanvas(this.doc.canvas);
    return this._push({ kind: 'full', canvas: c, bytes: c.width * c.height * 4 });
  }

  _push(e) {
    e.id = ++this.seq;
    this.undoStack.push(e);
    for (const r of this.redoStack) this._release(r);
    this.redoStack = [];
    while (this.undoStack.length > this.limit) this._release(this.undoStack.shift());
    this._scheduleCompress();
    this.onChange?.();
    return e;
  }

  _release(e) {
    e.data = null;
    e.canvas = null;
    e.blob = null;
  }

  undo() {
    return this._run(this.undoStack, this.redoStack);
  }
  redo() {
    return this._run(this.redoStack, this.undoStack);
  }

  _run(from, to) {
    const p = this.queue.then(async () => {
      const e = from.pop();
      if (!e) return false;
      try {
        await this._swap(e);
      } catch (err) {
        console.error('[paint] history step failed', err);
        this._release(e);
        this.onChange?.();
        throw err;
      }
      to.push(e);
      this.onChange?.();
      return true;
    });
    this.queue = p.catch(() => {});
    return p;
  }

  async _swap(e) {
    const { ctx } = this.doc;
    if (e.kind === 'region') {
      const { x, y, w, h } = e.rect;
      const cur = ctx.getImageData(x, y, w, h);
      if (e.blob) {
        const bmp = await createImageBitmap(e.blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        ctx.clearRect(x, y, w, h);
        ctx.drawImage(bmp, x, y);
        bmp.close?.();
        e.blob = null;
      } else ctx.putImageData(e.data, x, y);
      e.data = cur;
      e.bytes = cur.data.length;
      return;
    }
    // Whole-image step: the stored canvas may have a different size.
    const cur = cloneCanvas(this.doc.canvas);
    let src = e.canvas;
    if (e.blob) {
      src = await createImageBitmap(e.blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      e.blob = null;
    }
    this.doc.resize(src.width, src.height);
    ctx.clearRect(0, 0, src.width, src.height);
    ctx.drawImage(src, 0, 0);
    src.close?.();
    e.canvas = cur;
    e.bytes = cur.width * cur.height * 4;
  }

  rawBytes() {
    let n = 0;
    for (const e of this.undoStack) if (!e.blob) n += e.bytes || 0;
    for (const e of this.redoStack) if (!e.blob) n += e.bytes || 0;
    return n;
  }

  _scheduleCompress() {
    if (this._timer || typeof OffscreenCanvas === 'undefined') return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._compressOne().catch((err) => console.warn('[paint] history compression failed', err));
    }, 250);
  }

  async _compressOne() {
    if (this.rawBytes() <= this.budget) return;
    const candidates = this.undoStack.slice(0, Math.max(0, this.undoStack.length - this.keepRaw));
    const e = candidates.find((x) => !x.blob && !x.compressing && (x.data || x.canvas));
    if (!e) return;
    e.compressing = true;
    const src = e.kind === 'region' ? e.data : e.canvas;
    const oc = new OffscreenCanvas(src.width, src.height);
    const octx = oc.getContext('2d');
    if (e.kind === 'region') octx.putImageData(src, 0, 0);
    else octx.drawImage(src, 0, 0);
    const blob = await oc.convertToBlob({ type: 'image/png' });
    e.compressing = false;
    // Only keep the blob if the step was not swapped meanwhile.
    if ((e.kind === 'region' && e.data === src) || (e.kind === 'full' && e.canvas === src)) {
      e.blob = blob;
      e.data = null;
      e.canvas = null;
    }
    this._scheduleCompress();
  }
}
