// Polices: fonts installed during this session, usable by name in every app at once.
// Chromium reads the font list (fontconfig) when the shell starts: a font installed later is listed by fontconfig
// (Éditeur de texte, Dessin… see it in their font lists at once) but Chromium would only draw it after the next
// sign-in. So each face installed here is also added to document.fonts under its real family name (a FontFace built
// from the file bytes, with the face's weight, style and width), and removed again when it is uninstalled. At the
// next sign-in Chromium finds the font by itself. (A font installed in an earlier session and uninstalled now stays
// drawable until the next sign-in: Chromium keeps what it loaded at start.)
const faces = new Map(); // installed file -> [FontFace]

export async function registerInstalled(api, results) {
  for (const r of results || []) {
    if ((r.status !== 'installed' && r.status !== 'replaced') || !r.dest) continue;
    unregister([r.dest]);
    const list = [];
    for (const f of r.faces || []) {
      try {
        const bytes = await api.invoke('fonts:bytes', r.dest, f.index || 0);
        const face = new FontFace(f.family, bytes, { weight: f.weight, style: f.style, stretch: f.stretch });
        await face.load();
        document.fonts.add(face);
        list.push(face);
      } catch {
        // (the font stays usable after the next sign-in)
      }
    }
    if (list.length) faces.set(r.dest, list);
  }
}

export function unregister(files) {
  for (const file of files || []) {
    for (const face of faces.get(file) || []) {
      try {
        document.fonts.delete(face);
      } catch {}
    }
    faces.delete(file);
  }
}

/** Files whose faces are registered (tests). */
export const registered = () => [...faces.keys()];
