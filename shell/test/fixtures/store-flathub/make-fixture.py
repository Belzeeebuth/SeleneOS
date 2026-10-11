#!/usr/bin/python3
# Generates the Flathub fixture used in dev mode and by test/store-flathub.test.mjs:
#   appstream.xml.gz            Flathub-format AppStream collection (desktop apps + a runtime, an addon, a console
#                               app, an end-of-life app and an invalid id that the helper must skip)
#   icons/64x64/<id>.png        cached icons (same layout as flatpak's appstream/flathub/<arch>/active/icons)
#   icons/128x128/<id>.png
# Deterministic (fixed gzip mtime). Usage: python3 make-fixture.py   (from any directory)
import gzip, os, struct, zlib
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))

def png(size, rgb):
    """Rounded square in the given colour with a light inner band (RGBA, no dependency)."""
    r, g, b = rgb
    rows = []
    rad = size // 5
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx = max(rad - x, 0, x - (size - 1 - rad))
            dy = max(rad - y, 0, y - (size - 1 - rad))
            inside = dx * dx + dy * dy <= rad * rad
            if not inside:
                row += bytes((0, 0, 0, 0))
            elif size * 0.42 < y < size * 0.58 and size * 0.2 < x < size * 0.8:
                row += bytes((255, 255, 255, 230))
            else:
                row += bytes((r, g, b, 255))
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')

# id, name, fr name, summary, fr summary, categories, colour, developer, license, version, keywords
APPS = [
    ('org.mozilla.firefox', 'Firefox', None, 'Fast, Private & Safe Web Browser', 'Navigateur web rapide, privé et sûr', ['Network', 'WebBrowser'], (230, 96, 0), 'Mozilla', 'MPL-2.0', '131.0.2', ['browser', 'web', 'internet']),
    ('org.gimp.GIMP', 'GNU Image Manipulation Program', 'Programme de manipulation d’images GNU', 'Create images and edit photographs', 'Créer des images et retoucher des photos', ['Graphics', '2DGraphics', 'RasterGraphics'], (92, 84, 70), 'The GIMP team', 'GPL-3.0+', '2.10.38', ['photo', 'paint', 'gimp']),
    ('com.spotify.Client', 'Spotify', None, 'Online music streaming service', 'Service de musique en ligne', ['Audio', 'Music', 'Player', 'AudioVideo'], (30, 185, 84), 'Spotify', 'LicenseRef-proprietary', '1.2.45', ['music', 'streaming']),
    ('com.discordapp.Discord', 'Discord', None, 'Messaging, voice and video client', 'Messagerie, voix et vidéo', ['Network', 'InstantMessaging'], (88, 101, 242), 'Discord Inc.', 'LicenseRef-proprietary', '0.0.70', ['chat', 'voice', 'gaming']),
    ('org.videolan.VLC', 'VLC', None, 'VLC media player, the open-source multimedia player', 'Lecteur multimédia VLC, le lecteur libre', ['AudioVideo', 'Player', 'Video'], (240, 130, 0), 'VideoLAN', 'GPL-2.0+', '3.0.21', ['video', 'player', 'dvd']),
    ('org.libreoffice.LibreOffice', 'LibreOffice', None, 'The LibreOffice productivity suite', 'La suite bureautique LibreOffice', ['Office', 'WordProcessor'], (24, 163, 70), 'The Document Foundation', 'MPL-2.0', '24.8.2', ['writer', 'calc', 'spreadsheet']),
    ('org.inkscape.Inkscape', 'Inkscape', None, 'Vector Graphics Editor', 'Éditeur de graphismes vectoriels', ['Graphics', 'VectorGraphics'], (40, 40, 40), 'Inkscape Developers', 'GPL-3.0+', '1.4', ['svg', 'vector', 'drawing']),
    ('org.kde.krita', 'Krita', None, 'Digital Painting, Creative Freedom', 'Peinture numérique, liberté créative', ['Graphics', 'RasterGraphics'], (60, 120, 220), 'KDE', 'GPL-3.0+', '5.2.6', ['paint', 'drawing']),
    ('com.visualstudio.code', 'Visual Studio Code', None, 'Code editing. Redefined.', 'L’édition de code, redéfinie.', ['Development', 'IDE', 'TextEditor'], (0, 122, 204), 'Microsoft', 'LicenseRef-proprietary', '1.94.2', ['editor', 'ide', 'code']),
    ('org.blender.Blender', 'Blender', None, 'Free and open source 3D creation suite', 'Suite de création 3D libre', ['Graphics', '3DGraphics'], (234, 118, 0), 'Blender Foundation', 'GPL-2.0+', '4.2.3', ['3d', 'modeling', 'render']),
    ('com.obsproject.Studio', 'OBS Studio', None, 'Live streaming and video recording software', 'Diffusion en direct et enregistrement vidéo', ['AudioVideo', 'Recorder'], (50, 50, 60), 'OBS Project', 'GPL-2.0+', '30.2.3', ['stream', 'record', 'screencast']),
    ('org.telegram.desktop', 'Telegram Desktop', None, 'Fast. Secure. Powerful.', 'Rapide. Sûr. Puissant.', ['Network', 'Chat'], (42, 171, 238), 'Telegram FZ-LLC', 'GPL-3.0', '5.6.3', ['chat', 'messenger']),
    ('com.valvesoftware.Steam', 'Steam', None, 'Launcher for the Steam software distribution service', 'Lanceur du service de distribution Steam', ['Game'], (23, 26, 33), 'Valve Corporation', 'LicenseRef-proprietary', '1.0.0.81', ['games', 'valve']),
    ('net.lutris.Lutris', 'Lutris', None, 'Video game preservation platform', 'Plateforme de préservation de jeux vidéo', ['Game'], (255, 153, 0), 'Lutris Team', 'GPL-3.0+', '0.5.17', ['games', 'wine']),
    ('org.audacityteam.Audacity', 'Audacity', None, 'Record and edit audio files', 'Enregistrer et modifier des fichiers audio', ['AudioVideo', 'Audio', 'AudioVideoEditing'], (0, 80, 170), 'Audacity Team', 'GPL-3.0+', '3.6.4', ['audio', 'sound', 'editor']),
    ('org.gnome.Calculator', 'Calculator', 'Calculatrice', 'Perform arithmetic, scientific or financial calculations', 'Effectuer des calculs arithmétiques, scientifiques ou financiers', ['GNOME', 'GTK', 'Utility', 'Calculator'], (120, 120, 130), 'The GNOME Project', 'GPL-3.0+', '47.0', ['calculation', 'arithmetic']),
    ('org.kde.kdenlive', 'Kdenlive', None, 'Video Editor', 'Éditeur vidéo', ['AudioVideo', 'Video', 'AudioVideoEditing'], (80, 60, 160), 'KDE', 'GPL-3.0+', '24.08.2', ['video', 'editor', 'montage']),
    ('org.signal.Signal', 'Signal Desktop', None, 'Private messenger', 'Messagerie privée', ['Network', 'InstantMessaging'], (58, 118, 240), 'Signal Messenger, LLC', 'AGPL-3.0', '7.28.0', ['chat', 'secure']),
    ('md.obsidian.Obsidian', 'Obsidian', None, 'Markdown-based knowledge base', 'Base de connaissances en Markdown', ['Office'], (124, 58, 237), 'Obsidian', 'LicenseRef-proprietary', '1.7.4', ['notes', 'markdown']),
    ('org.gnome.Builder', 'Builder', None, 'Create applications for GNOME', 'Créer des applications pour GNOME', ['Development', 'IDE'], (60, 140, 90), 'The GNOME Project', 'GPL-3.0+', '47.0', ['ide', 'code', 'gnome']),
    ('org.stellarium.Stellarium', 'Stellarium', None, 'Planetarium', 'Planétarium', ['Science', 'Astronomy', 'Education'], (20, 30, 80), 'Stellarium team', 'GPL-2.0+', '24.3', ['stars', 'sky']),
    ('io.github.example.Notes', 'Example Notes', None, 'Notes with a broken icon name', 'Notes avec un nom d’icône invalide', ['Utility'], (200, 200, 200), 'Example', 'MIT', '1.0', ['notes']),
]

def component(a):
    app_id, name, name_fr, summary, summary_fr, cats, rgb, dev, lic, ver, kws = a
    old_style = app_id == 'org.videolan.VLC'   # pre-2020 collection: <id> with .desktop suffix, type="desktop"
    ctype = 'desktop' if app_id in ('org.videolan.VLC', 'org.blender.Blender') else 'desktop-application'
    x = ['  <component type="%s">' % ctype]
    x.append('    <id>%s</id>' % (app_id + '.desktop' if old_style else app_id))
    x.append('    <name>%s</name>' % escape(name))
    if name_fr:
        x.append('    <name xml:lang="fr">%s</name>' % escape(name_fr))
    x.append('    <name xml:lang="x-test">xxx%sxxx</name>' % escape(name))
    x.append('    <summary>%s</summary>' % escape(summary))
    x.append('    <summary xml:lang="fr_FR">%s</summary>' % escape(summary_fr))
    if app_id == 'org.gimp.GIMP':
        # collection style: one <description> per language
        x.append('    <description><p>GIMP is an image editor.</p><p>Features:</p><ul><li>Layers and masks</li><li>Plug-ins</li></ul></description>')
        x.append('    <description xml:lang="fr"><p>GIMP est un éditeur d’images.</p><p>Fonctions :</p><ul><li>Calques et masques</li><li>Greffons</li></ul></description>')
    elif app_id == 'org.mozilla.firefox':
        # metainfo style: xml:lang on each paragraph
        x.append('    <description><p>Firefox is a <em>fast</em> browser.</p><p xml:lang="fr">Firefox est un navigateur <em>rapide</em>.</p>'
                 '<p>It   respects\n   your privacy.</p><p xml:lang="fr">Il respecte votre vie privée.</p></description>')
    elif app_id == 'org.inkscape.Inkscape':
        x.append('    <description><p>%s</p></description>' % ('Long text. ' * 600))
    else:
        x.append('    <description><p>%s.</p></description>' % escape(summary))
    if app_id == 'io.github.example.Notes':
        x.append('    <icon type="cached" width="64" height="64">../../../etc/passwd</icon>')
    elif app_id == 'md.obsidian.Obsidian':
        x.append('    <icon type="remote" width="128" height="128">https://dl.flathub.org/media/md/obsidian/Obsidian/icons/128x128/md.obsidian.Obsidian.png</icon>')
    elif app_id == 'org.gnome.Calculator':
        x.append('    <icon type="cached" width="64" height="64">%s.png</icon>' % app_id)
    else:
        x.append('    <icon type="cached" width="64" height="64">%s.png</icon>' % app_id)
        x.append('    <icon type="cached" width="128" height="128">%s.png</icon>' % app_id)
        x.append('    <icon type="remote" width="128" height="128">https://dl.flathub.org/media/%s.png</icon>' % app_id)
    x.append('    <categories>%s</categories>' % ''.join('<category>%s</category>' % c for c in cats))
    x.append('    <keywords>%s<keyword xml:lang="fr">motclé-%s</keyword></keywords>' % (''.join('<keyword>%s</keyword>' % k for k in kws), kws[0]))
    x.append('    <url type="homepage">https://example.org/%s</url>' % app_id)
    x.append('    <launchable type="desktop-id">%s.desktop</launchable>' % app_id)
    x.append('    <bundle type="flatpak" runtime="org.gnome.Platform/x86_64/47" sdk="org.gnome.Sdk/x86_64/47">app/%s/x86_64/stable</bundle>' % app_id)
    x.append('    <project_license>%s</project_license>' % lic)
    if app_id == 'com.spotify.Client':
        x.append('    <developer id="com.spotify"><name>%s</name></developer>' % escape(dev))
    else:
        x.append('    <developer_name>%s</developer_name>' % escape(dev))
    n = 5 if app_id == 'org.gimp.GIMP' else 2
    x.append('    <screenshots>')
    for i in range(n):
        x.append('      <screenshot%s><caption>Shot %d</caption><image type="source">https://example.org/%s/source-%d.png</image>'
                 '<image type="thumbnail" width="624" height="351">https://dl.flathub.org/media/%s/624/%d.png</image>'
                 '<image type="thumbnail" width="112" height="63">https://dl.flathub.org/media/%s/112/%d.png</image></screenshot>'
                 % (' type="default"' if i == 0 else '', i, app_id, i, app_id, i, app_id, i))
    if app_id == 'org.mozilla.firefox':
        x.append('      <screenshot><image type="source">http://insecure.example.org/shot.png</image></screenshot>')
    x.append('    </screenshots>')
    x.append('    <releases><release version="%s" timestamp="1727000000"/><release version="0.1" timestamp="1500000000"/></releases>' % ver)
    x.append('    <content_rating type="oars-1.1"/>')
    x.append('  </component>')
    return '\n'.join(x)

SKIPPED = '''
  <component type="runtime">
    <id>org.gnome.Platform</id>
    <name>GNOME Application Platform version 47</name>
    <summary>Shared libraries used by GNOME applications</summary>
    <bundle type="flatpak">runtime/org.gnome.Platform/x86_64/47</bundle>
  </component>
  <component type="addon">
    <id>org.freedesktop.Platform.GL.default</id>
    <extends>org.freedesktop.Platform</extends>
    <name>Mesa</name>
    <summary>Graphics drivers</summary>
  </component>
  <component type="console-application">
    <id>org.example.Cli</id>
    <name>Example CLI</name>
    <summary>A command-line tool</summary>
  </component>
  <component type="desktop-application">
    <id>org.example.OldApp</id>
    <name>Old App</name>
    <summary>An end-of-life application</summary>
    <bundle type="flatpak">app/org.example.OldApp/x86_64/stable</bundle>
    <custom><value key="flathub::eol">This application is no longer maintained</value></custom>
  </component>
  <component type="desktop-application">
    <id>bad id; rm -rf ~</id>
    <name>Bad Id</name>
    <summary>Invalid application id</summary>
  </component>
  <component type="desktop-application" merge="append">
    <id>org.gimp.GIMP</id>
    <name>Merge entry</name>
  </component>
'''

def main():
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n<components version="0.14" origin="flathub">\n'
    xml += '\n'.join(component(a) for a in APPS) + SKIPPED + '</components>\n'
    with open(os.path.join(HERE, 'appstream.xml.gz'), 'wb') as f:
        with gzip.GzipFile(filename='appstream.xml', mode='wb', fileobj=f, mtime=0) as gz:
            gz.write(xml.encode('utf-8'))
    for size in (64, 128):
        d = os.path.join(HERE, 'icons', '%dx%d' % (size, size))
        os.makedirs(d, exist_ok=True)
        for a in APPS:
            if a[0] in ('io.github.example.Notes', 'md.obsidian.Obsidian') or (size == 128 and a[0] == 'org.gnome.Calculator'):
                continue
            with open(os.path.join(d, a[0] + '.png'), 'wb') as f:
                f.write(png(size, a[6]))
    print('%d apps' % len(APPS))

if __name__ == '__main__':
    main()
