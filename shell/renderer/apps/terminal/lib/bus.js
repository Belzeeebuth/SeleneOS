// One subscription to the PTY events for the whole shell page, routed to the owning session.
//   bus.attach(api)  bus.register(ptyId, session)  bus.unregister(ptyId)
// A session implements onPtyData(data), onPtyExit(code), onPtyProc({ name, pid, busy }).
const sessions = new Map();
let attached = false;
const early = new Map(); // ptyId -> events that arrived before register() (spawn reply raced the output)

function route(id, fn) {
  const s = sessions.get(id);
  if (s) fn(s);
  else {
    if (!early.has(id)) {
      early.set(id, []);
      setTimeout(() => early.delete(id), 5000);
    }
    const q = early.get(id);
    if (q.length < 1000) q.push(fn);
  }
}

export const bus = {
  attach(api) {
    if (attached) return;
    attached = true;
    api.on('pty:data', ({ id, data }) => route(id, (s) => s.onPtyData(data)));
    api.on('pty:exit', ({ id, code }) => route(id, (s) => s.onPtyExit(code)));
    api.on('pty:proc', (p) => route(p.id, (s) => s.onPtyProc(p)));
  },
  register(id, session) {
    sessions.set(id, session);
    const q = early.get(id);
    if (q) {
      early.delete(id);
      for (const fn of q) fn(session);
    }
  },
  unregister(id) {
    sessions.delete(id);
  },
  get size() {
    return sessions.size;
  },
};
