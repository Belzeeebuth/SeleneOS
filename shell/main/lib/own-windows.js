'use strict';
// Top-level X11 windows the shell process opens itself (the Navigateur's sign-in pop-ups: main/ipc/browser.js).
// aurora-xwm frames them like any X client; xapps:match (main/ipc/xapps.js) names their app from here so the frame,
// the taskbar and Alt+Tab show « Navigateur » and its icon instead of an unknown program.
const apps = new Map(); // XID -> app id

function xidOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch {
    return null;
  }
}

/** Remembers a BrowserWindow as the given shell app until it closes. */
function register(win, appId) {
  const xid = xidOf(win);
  if (!xid) return null;
  apps.set(xid, appId);
  win.once('closed', () => apps.delete(xid));
  return xid;
}

function appFor(xid) {
  return apps.get(Number(xid)) || null;
}

module.exports = { register, appFor, xidOf };
