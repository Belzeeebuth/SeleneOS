'use strict';
// Stub Flathub source for test/store.test.mjs (see _stub.js).
const A = (id, name, summary, categories, extra = {}) => ({ id, appId: id, name, summary, categories, ...extra });
module.exports = require('./_stub')('flathub', 'Flathub', [
  A('org.mozilla.firefox', 'Firefox', 'Fast, Private & Safe Web Browser', ['Network'], { summaryFr: 'Navigateur web rapide, privé et sûr', developer: 'Mozilla' }),
  A('org.chromium.Chromium', 'Chromium', 'The web browser from Chromium project', ['Network']),
  A('com.spotify.Client', 'Spotify', 'Online music streaming service', ['AudioVideo']),
  A('com.discordapp.Discord', 'Discord', 'Messaging, voice and video client', ['Network']),
  A('org.gimp.GIMP', 'GNU Image Manipulation Program', 'Create images and edit photographs', ['Graphics'], { developer: 'The GIMP team' }),
  A('org.inkscape.Inkscape', 'Inkscape', 'Vector Graphics Editor', ['Graphics']),
  A('org.videolan.VLC', 'VLC', 'VLC media player, the open-source multimedia player', ['AudioVideo']),
  A('org.libreoffice.LibreOffice', 'LibreOffice', 'The LibreOffice productivity suite', ['Office']),
  A('org.kde.krita', 'Krita', 'Digital Painting, Creative Freedom', ['Graphics']),
  A('com.obsproject.Studio', 'OBS Studio', 'Live streaming and video recording software', ['AudioVideo']),
  A('org.blender.Blender', 'Blender', 'Free and open source 3D creation suite', ['Graphics']),
  A('org.audacityteam.Audacity', 'Audacity', 'Record and edit audio files', ['AudioVideo']),
  A('org.telegram.desktop', 'Telegram Desktop', 'Fast. Secure. Feature-rich.', ['Network']),
  A('org.gnome.Chess', 'Chess', 'Play the classic two-player board game of chess', ['Game']),
  A('net.supertuxkart.SuperTuxKart', 'SuperTuxKart', 'A 3D open-source arcade racer', ['Game']),
  A('org.stellarium.Stellarium', 'Stellarium', 'Planetarium', ['Science', 'Education']),
  A('com.visualstudio.code', 'Visual Studio Code', 'Code editing. Redefined.', ['Development']),
]);
