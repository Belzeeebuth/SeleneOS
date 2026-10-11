'use strict';
// Stub Ubuntu (DEP-11) source for test/store.test.mjs (see _stub.js). ids are apt package names.
const A = (id, appId, name, summary, categories, extra = {}) => ({ id, appId, name, summary, categories, ...extra });
module.exports = require('./_stub')('ubuntu', 'Ubuntu', [
  A('gimp', 'org.gimp.GIMP', 'GNU Image Manipulation Program', 'Create images and edit photographs', ['Graphics'], { desktopId: 'gimp.desktop' }),
  A('inkscape', 'org.inkscape.Inkscape', 'Inkscape', 'Vector Graphics Editor', ['Graphics']),
  A('vlc', 'org.videolan.VLC', 'VLC media player', 'Read, capture, broadcast your multimedia streams', ['AudioVideo'], { desktopId: 'vlc.desktop' }),
  A('gnome-chess', 'org.gnome.Chess', 'Chess', 'Play the classic two-player board game of chess', ['Game'], { summaryFr: 'Jouer au jeu d’échecs classique à deux joueurs' }),
  A('stellarium', 'org.stellarium.Stellarium', 'Stellarium', 'Planetarium software', ['Science', 'Education']),
  A('geany', 'org.geany.Geany', 'Geany', 'A fast and lightweight IDE', ['Development']),
  A('gnucash', 'org.gnucash.GnuCash', 'GnuCash', 'Manage your finances, accounts, and investments', ['Office']),
  A('supertuxkart', 'net.supertuxkart.SuperTuxKart', 'SuperTuxKart', 'A 3D open-source arcade racer', ['Game']),
  A('kalzium', 'org.kde.kalzium', 'Kalzium', 'Periodic Table of Elements', ['Science', 'Education'], { noIcon: true }),
  A('gnome-calculator', 'org.gnome.Calculator', 'Calculator', 'Perform arithmetic, scientific or financial calculations', ['Utility']),
]);
