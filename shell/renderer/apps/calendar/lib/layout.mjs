// Layout helpers for the calendar views. Pure module (shell + Node).
//   layoutColumns(items, { minDuration }) -> items annotated with { col, cols, span }
//       Overlapping timed events of one day are placed side by side (Outlook style): events that
//       overlap form a cluster, each gets the first free column, and widens to the right while free.
//   packLanes(items) -> items annotated with { lane }: interval [startDay, endDay) packing for
//       all-day bars and month rows (longer items first so multi-day bars stay on top).

export function layoutColumns(items, { minDuration = 0 } = {}) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const vEnd = (e) => Math.max(e.end, e.start + minDuration);
  const clusters = [];
  let cur = null;
  let curEnd = -Infinity;
  for (const e of sorted) {
    if (!cur || e.start >= curEnd) {
      cur = [];
      clusters.push(cur);
      curEnd = -Infinity;
    }
    cur.push(e);
    curEnd = Math.max(curEnd, vEnd(e));
  }
  for (const cl of clusters) {
    const colEnds = [];
    for (const e of cl) {
      let c = colEnds.findIndex((end) => end <= e.start);
      if (c < 0) {
        c = colEnds.length;
        colEnds.push(0);
      }
      colEnds[c] = vEnd(e);
      e.col = c;
    }
    const cols = colEnds.length;
    for (const e of cl) {
      e.cols = cols;
      // widen into free columns on the right
      let span = 1;
      for (let c = e.col + 1; c < cols; c++) {
        const blocked = cl.some((o) => o !== e && o.col === c && o.start < vEnd(e) && vEnd(o) > e.start);
        if (blocked) break;
        span++;
      }
      e.span = span;
    }
  }
  return sorted;
}

export function packLanes(items) {
  const sorted = [...items].sort((a, b) => a.startDay - b.startDay || b.endDay - b.startDay - (a.endDay - a.startDay) || (a.order ?? 0) - (b.order ?? 0));
  const laneEnds = [];
  for (const it of sorted) {
    let lane = laneEnds.findIndex((end) => end <= it.startDay);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = it.endDay;
    it.lane = lane;
  }
  return sorted;
}
