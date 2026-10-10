// Text tool layout: wraps like a CSS `white-space: pre-wrap; overflow-wrap: break-word` textarea
// so the canvas preview, the editing caret and the committed pixels agree.
//   const L = layoutText(ctx, text, width, opts)  -> { lines: [{ text, width }], lineHeight, ascent, descent }
//   renderText(ctx, box, text, opts)               -> draws into ctx
// opts: { family, sizePx, bold, italic, underline, strike, color, background (null = transparent) }

export const PT_TO_PX = 96 / 72;

export function fontString(o, scale = 1) {
  const fam = String(o.family || 'sans-serif').replace(/"/g, '');
  return `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${(o.sizePx * scale).toFixed(3)}px "${fam}", sans-serif`;
}

export function metrics(ctx, o) {
  ctx.font = fontString(o);
  const m = ctx.measureText('Hgjy|ÉÀ');
  const ascent = m.fontBoundingBoxAscent ?? o.sizePx * 0.9;
  const descent = m.fontBoundingBoxDescent ?? o.sizePx * 0.25;
  return { ascent, descent, lineHeight: Math.ceil(ascent + descent) };
}

function breakLong(ctx, word, width) {
  const parts = [];
  let cur = '';
  for (const ch of word) {
    if (cur && ctx.measureText(cur + ch).width > width) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

export function layoutText(ctx, text, width, o) {
  const met = metrics(ctx, o);
  ctx.font = fontString(o);
  const lines = [];
  const w = Math.max(1, width);
  for (const para of String(text).split('\n')) {
    const tokens = para.split(/(\s+)/).filter((x) => x !== '');
    let line = '';
    if (!tokens.length) {
      lines.push('');
      continue;
    }
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) {
        line += tok; // trailing spaces hang
        continue;
      }
      const cand = line + tok;
      if (ctx.measureText(cand.trimEnd()).width <= w) {
        line = cand;
        continue;
      }
      if (line.trim()) lines.push(line);
      line = '';
      if (ctx.measureText(tok).width > w) {
        const parts = breakLong(ctx, tok, w);
        for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i]);
        line = parts[parts.length - 1];
      } else line = tok;
    }
    lines.push(line);
  }
  return { lines: lines.map((t) => ({ text: t, width: ctx.measureText(t.trimEnd()).width })), ...met };
}

export function renderText(ctx, box, text, o) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  if (o.background) {
    ctx.fillStyle = o.background;
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  const L = layoutText(ctx, text, box.w, o);
  ctx.font = fontString(o);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = o.color;
  const pad = (L.lineHeight - (L.ascent + L.descent)) / 2;
  const thick = Math.max(1, Math.round(o.sizePx / 15));
  L.lines.forEach((ln, i) => {
    const base = box.y + i * L.lineHeight + pad + L.ascent;
    ctx.fillText(ln.text, box.x, base);
    if (o.underline && ln.width) ctx.fillRect(box.x, Math.round(base + Math.max(1, o.sizePx * 0.09)), ln.width, thick);
    if (o.strike && ln.width) ctx.fillRect(box.x, Math.round(base - L.ascent * 0.3), ln.width, thick);
  });
  ctx.restore();
  return L;
}
