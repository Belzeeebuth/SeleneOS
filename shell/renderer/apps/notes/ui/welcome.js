// First-run content: a "Welcome to Notes" note in the user's language that shows what the editor can do.
const EN = {
  notebook: 'My notes',
  title: 'Welcome to Notes',
  html: `<div>Notes keeps your ideas, lists and pictures in one place. Everything is saved automatically as you type, in <code>Documents/Notes</code>.</div>
<h2>Get started</h2>
<ul data-type="checklist">
<li data-checked="true">Open this note</li>
<li data-checked="false">Create a note with <b>Ctrl+N</b> and a notebook with <b>Ctrl+Shift+N</b></li>
<li data-checked="false">Pin an important note with <b>Ctrl+P</b> so it stays on top</li>
<li data-checked="false">Click a box to tick it off</li>
</ul>
<h2>Write with style</h2>
<ul>
<li><b>Bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s> and <code>inline code</code></li>
<li><mark data-hl="yellow">Highlights</mark> and <span data-color="blue">text colours</span> that look right in light and dark mode</li>
<li>Bulleted, numbered and check lists, quotes, code blocks, tables and pictures</li>
</ul>
<blockquote>Tip: paste or drag pictures straight into a note. They are stored next to it.</blockquote>
<h3>Markdown shortcuts</h3>
<table><tbody>
<tr><th>Type</th><th>To get</th></tr>
<tr><td><code># </code> <code>## </code> <code>### </code></td><td>Headings</td></tr>
<tr><td><code>- </code> or <code>1. </code></td><td>Bulleted or numbered list</td></tr>
<tr><td><code>[] </code></td><td>Checklist</td></tr>
<tr><td><code>&gt; </code> and <code>\`\`\`</code></td><td>Quote and code block</td></tr>
<tr><td><code>**bold**</code> <code>*italic*</code> <code>~~strike~~</code></td><td>Inline formatting</td></tr>
</tbody></table>
<pre>function hello() {
  return "Code blocks keep spacing and use a monospace font";
}</pre>
<h3>Find anything</h3>
<div>Search every note from the box at the top (<b>Ctrl+E</b>), or find text in this note with <b>Ctrl+F</b>. Type a hash sign right before a word to tag a note. Tags show up in the side pane, like these: #welcome #tips</div>
<div>Links open in the Browser with Ctrl+click: <a href="https://en.wikipedia.org/wiki/Note-taking">Note-taking on Wikipedia</a></div>
<hr>
<div>Export a note as Markdown, text or HTML, import <code>.md</code> files, or send it by e-mail from the <b>⋯</b> menu.</div>`,
};

const FR = {
  notebook: 'Mes notes',
  title: 'Bienvenue dans Notes',
  html: `<div>Notes rassemble vos idées, vos listes et vos images. Tout est enregistré automatiquement pendant la saisie, dans <code>Documents/Notes</code>.</div>
<h2>Pour commencer</h2>
<ul data-type="checklist">
<li data-checked="true">Ouvrir cette note</li>
<li data-checked="false">Créer une note avec <b>Ctrl+N</b> et un carnet avec <b>Ctrl+Maj+N</b></li>
<li data-checked="false">Épingler une note importante avec <b>Ctrl+P</b> pour la garder en haut</li>
<li data-checked="false">Cliquer sur une case pour la cocher</li>
</ul>
<h2>Mettez en forme</h2>
<ul>
<li><b>Gras</b>, <i>italique</i>, <u>souligné</u>, <s>barré</s> et <code>code en ligne</code></li>
<li><mark data-hl="yellow">Surlignages</mark> et <span data-color="blue">couleurs de texte</span> lisibles en mode clair comme en mode sombre</li>
<li>Listes à puces, numérotées et cases à cocher, citations, blocs de code, tableaux et images</li>
</ul>
<blockquote>Astuce : collez ou faites glisser des images directement dans une note. Elles sont enregistrées à côté d’elle.</blockquote>
<h3>Raccourcis Markdown</h3>
<table><tbody>
<tr><th>Tapez</th><th>Pour obtenir</th></tr>
<tr><td><code># </code> <code>## </code> <code>### </code></td><td>Titres</td></tr>
<tr><td><code>- </code> ou <code>1. </code></td><td>Liste à puces ou numérotée</td></tr>
<tr><td><code>[] </code></td><td>Liste de cases à cocher</td></tr>
<tr><td><code>&gt; </code> et <code>\`\`\`</code></td><td>Citation et bloc de code</td></tr>
<tr><td><code>**gras**</code> <code>*italique*</code> <code>~~barré~~</code></td><td>Mise en forme du texte</td></tr>
</tbody></table>
<pre>function bonjour() {
  return "Les blocs de code gardent les espaces et une police à chasse fixe";
}</pre>
<h3>Retrouvez tout</h3>
<div>Cherchez dans toutes les notes depuis la zone en haut (<b>Ctrl+E</b>) ou trouvez du texte dans cette note avec <b>Ctrl+F</b>. Tapez un dièse juste avant un mot pour étiqueter une note. Les étiquettes apparaissent dans le volet latéral, comme celles-ci : #bienvenue #astuces</div>
<div>Les liens s’ouvrent dans le Navigateur Selene avec Ctrl+clic : <a href="https://fr.wikipedia.org/wiki/Prise_de_notes">La prise de notes sur Wikipédia</a></div>
<hr>
<div>Exportez une note en Markdown, texte ou HTML, importez des fichiers <code>.md</code> ou envoyez-la par e-mail depuis le menu <b>⋯</b>.</div>`,
};

export function welcomeSeed(lang) {
  const w = lang === 'fr' ? FR : EN;
  return { notebookName: w.notebook, title: w.title, html: w.html.replace(/\n(?=<)/g, '') };
}
