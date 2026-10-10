// Aurora Chess — AI worker. Runs the search off the UI thread.
//   in : { id, type: 'think', startFen, moves: [uci…], level, timeMs?, depth?, analysis? }
//   out: { id, type: 'result', move, score, mate, depth, nodes, pv, book, time } | { id, type: 'error', message }
// A running search cannot be interrupted by a message; the UI terminates the worker to cancel.
import { Engine, positionFrom } from './ai.mjs';

const engine = new Engine();

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type !== 'think') return;
  try {
    const pos = positionFrom(msg.startFen, msg.moves || []);
    const res = engine.think(pos, {
      level: msg.level,
      timeMs: msg.timeMs,
      depth: msg.depth,
      analysis: !!msg.analysis,
      history: msg.moves || [],
      startFen: msg.startFen,
    });
    self.postMessage({ id: msg.id, type: 'result', ...res });
  } catch (err) {
    self.postMessage({ id: msg.id, type: 'error', message: String(err?.message || err) });
  }
};

self.postMessage({ type: 'ready' });
