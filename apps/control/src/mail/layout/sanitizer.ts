/**
 * ===========================================================================
 * DER SÄUBERER — was aus dem Redaktionsfeld als HTML durchkommt
 * ===========================================================================
 *
 * Im CRM lässt sich der Rumpf einer Mail FORMATIERT eingeben: fett, kursiv,
 * unterstrichen, Absätze, Zeilenumbrüche. Was die Oberfläche dafür schickt,
 * ist ungeprüfte Eingabe — sie kommt zwar aus einem angemeldeten Browser, aber
 * „angemeldet" heisst nicht „unverdorben". Ein übernommener Absatz aus einer
 * fremden Quelle bringt Formatierungen, Verweise und Skripte mit, die niemand
 * absichtlich eingefügt hat.
 *
 * WHITELIST, NICHT BLACKLIST. Es gibt genau fünf erlaubte Auszeichnungen, und
 * alles andere fällt weg. Eine Liste verbotener Tags wäre die falsche
 * Richtung: Sie müsste vollständig sein, und sie ist es nie — `<svg>`,
 * `<math>`, `<object>`, `<template>`, `<base>` und jedes künftige Element
 * müssten einzeln nachgetragen werden. Dieselbe Begründung wie bei
 * `EMPFAENGERBEZOGENE_KLASSEN` in `mail.service.ts`: Wenn der unbekannte Fall
 * Folgen hat, zählt man die erlaubten Fälle auf.
 *
 * ES GIBT KEINE ATTRIBUTE. Nicht „keine gefährlichen Attribute", sondern gar
 * keine. Damit ist die ganze Familie der Ereignis-Attribute (`onerror`,
 * `onclick`, …), `style`, `src`, `srcset` und `href` mit einer einzigen Regel
 * erledigt statt mit einer Liste, die jemand pflegen müsste. Auch `javascript:`
 * braucht deshalb keine eigene Prüfung: Es gibt kein Attribut, in dem es
 * stehen könnte.
 *
 * KEINE LINKS AUS DEM REDAKTIONSFELD. Der einzige Verweis in einer Mail ist
 * der, den der RAHMEN setzt — der Abmeldelink im werblichen Kanal. Ein
 * `<a href>` aus dem Redaktionsfeld wäre genau der Weg, auf dem ein
 * umgeleiteter Link oder ein Zählpixel-Ersatz in eine Rundmail käme, und beides
 * steht auf der Verbotsliste des Auftrags. Der Text der Adresse bleibt
 * erhalten, die Verlinkung nicht.
 *
 * KEIN `<img>`. Ein Bild, das beim Öffnen geladen wird, meldet dem Absender,
 * dass die Mail geöffnet wurde — also eine Öffnungsmessung durch die
 * Hintertür, auch ohne dass es jemand so nennt.
 *
 * WAS AUS DEMSELBEN HTML WIRD: der Textteil. `textAus()` leitet ihn aus dem
 * GESÄUBERTEN HTML ab und nicht aus der Eingabe — sonst hätten beide Teile
 * verschiedene Quellen und liefen auseinander. Eine Mail, deren Textteil etwas
 * anderes sagt als ihr HTML-Teil, ist genau das Muster, auf das Spamfilter
 * anspringen.
 */

/** Die fünf erlaubten Auszeichnungen. Mehr wird es nicht. */
export const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'u'] as const;

/** `<br>` hat keinen Inhalt und wird nie geschlossen. */
const EMPTY_TAGS = new Set<string>(['br']);

/**
 * Verworfene Tags, deren INHALT ebenfalls verschwindet.
 *
 * Bei allen anderen verworfenen Tags bleibt der Text stehen — aus
 * `<div>Hallo</div>` wird `Hallo`. Bei diesen hier wäre das falsch: Der Inhalt
 * eines `<script>` ist Programmtext und keine Nachricht, und im Fliesstext
 * gelandet wäre er bestenfalls Unsinn und schlimmstenfalls eine Anleitung.
 */
const CONTENT_DISCARD = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'iframe',
  'noscript',
  'noframes',
  'xmp',
  'template',
]);

/** Wie tief Auszeichnungen ineinander liegen dürfen. */
const MAX_DEPTH = 20;

/**
 * Unsichtbare Zeichen, die einen Tag-Namen tarnen können.
 *
 * Ein `<scr` U+200B `ipt>` liest ein Mensch als „script", ein naiver Vergleich
 * nicht — und manche Empfängerprogramme werfen die Null-Breite beim Anzeigen
 * weg und sehen wieder `<script>`. Sie fliegen deshalb VOR dem Zerlegen raus,
 * nicht danach. Dasselbe gilt für ein eingestreutes Steuerzeichen (`<` U+0000
 * `script>`) und für die Bidi-Zeichen, mit denen sich Text in der Anzeige
 * umdrehen lässt.
 *
 * Tabulator, Zeilenumbruch und Wagenrücklauf bleiben — sie sind Textinhalt.
 * Das geschützte Leerzeichen (U+00A0) bleibt ebenfalls: es IST ein Zeichen.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Eine Zeichenfolge, die als HTML-Entität durchgehen darf.
 *
 * Sie bleibt stehen, statt zu `&amp;…` zu werden: Der Editor schickt für ein
 * kaufmännisches Und `&amp;`, und daraus `&amp;amp;` zu machen zeigte der
 * Empfängerin wörtlich „&amp;". Gefährlich ist das nicht — eine Entität im
 * TEXTINHALT wird angezeigt und nicht ausgeführt, auch `&#x3c;script&#x3e;`
 * ergibt nur die sichtbaren Zeichen `<script>`.
 */
const ENTITY = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

/**
 * Escaped Textinhalt. Bestehende Entitäten bleiben, alles andere wird sicher.
 *
 * BEIDE ANFÜHRUNGSZEICHEN WERDEN MITGENOMMEN, obwohl sie im Textinhalt
 * ungefährlich sind. Der Grund steht an der Aufrufstelle: `rahmen.ts` setzt das
 * Ergebnis auch in einen ATTRIBUTWERT (`<a href="…">`). Dort bricht ein `"` aus
 * dem Attribut aus und kann eigene Attribute anhängen.
 *
 * Ausnutzbar ist das heute nicht — der Abmeldelink besteht aus einer Basis-URL
 * aus der Umgebung und einem serverseitig erzeugten Token, beides ohne
 * Anführungszeichen. Es ist eine Robustheitslücke, kein offener Weg. Sie wird
 * trotzdem hier geschlossen und nicht über eine zweite Funktion: Eine Funktion,
 * die „escape" heisst, soll für den Kontext reichen, in dem sie benutzt wird —
 * sonst muss sich jede künftige Aufrufstelle daran erinnern, welche der beiden
 * die richtige ist.
 *
 * `'` MUSS MIT, sonst verschöbe sich das Problem nur auf einfach zitierte
 * Attribute. SICHTBAR ÄNDERT SICH DADURCH NICHTS: Im Textinhalt wird `&quot;`
 * als `"` gerendert, und `textAus()` verwandelt beide Entitäten über `BENANNT`
 * bzw. den numerischen Zweig zurück. `saeuberer.spec.ts` hält beides fest.
 */
export function escapeContent(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const characters = value[i]!;
    if (characters === '<') {
      result += '&lt;';
    } else if (characters === '>') {
      result += '&gt;';
    } else if (characters === '"') {
      result += '&quot;';
    } else if (characters === "'") {
      result += '&#39;';
    } else if (characters === '&') {
      const hit = ENTITY.exec(value.slice(i, i + 36));
      if (hit) {
        result += hit[0];
        i += hit[0].length - 1;
      } else {
        result += '&amp;';
      }
    } else {
      result += characters;
    }
  }
  return result;
}

/** Ein erkannter Tag im Eingabestrom. */
interface Tag {
  name: string;
  closing: boolean;
  /** Position hinter dem `>` — oder das Ende, wenn keines mehr kommt. */
  further: number;
  /**
   * Kam überhaupt noch ein `>`?
   *
   * `Text <strong` ohne Abschluss ist KEIN Tag. Browser verwerfen einen Tag,
   * der am Dateiende abbricht, und hier muss es genauso sein: Sonst öffnete
   * ein abgeschnittener Redaktionstext eine Auszeichnung, die der Säuberer
   * am Ende brav wieder schliesst — und aus einem Tippfehler würde ein
   * `<strong></strong>` im Wortlaut.
   */
  completed: boolean;
}

/**
 * Findet das Ende eines Tags und beachtet dabei ANFÜHRUNGSZEICHEN.
 *
 * Nötig wegen `<p title="a > b">`: Wer beim ersten `>` abbricht, hält `b">` für
 * Textinhalt. Und genau darüber liefe der Trick, ein `<script>` in einem
 * Attributwert zu verstecken — es stünde nach dem vermeintlichen Tagende
 * plötzlich wieder im Inhalt.
 */
function tagEnde(source: string, ab: number): number {
  let inQuotation: string | null = null;
  for (let i = ab; i < source.length; i += 1) {
    const characters = source[i]!;
    if (inQuotation !== null) {
      if (characters === inQuotation) inQuotation = null;
      continue;
    }
    if (characters === '"' || characters === "'") inQuotation = characters;
    else if (characters === '>') return i + 1;
  }
  return source.length;
}

/** Liest den Tag an Position `ab` (dort steht ein `<`). `null` = kein Tag. */
function readTag(source: string, ab: number): Tag | null {
  const header = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(
    source.slice(ab, ab + 40),
  );
  if (!header) return null;
  const further = tagEnde(source, ab);
  return {
    name: header[2]!.toLowerCase(),
    closing: header[1] === '/',
    further,
    completed: further < source.length || source.endsWith('>'),
  };
}

/** Überspringt den Inhalt bis zum passenden schliessenden Tag. */
function skipContent(source: string, ab: number, name: string): number {
  const end = new RegExp(`</\\s*${name}\\b`, 'i');
  const hit = end.exec(source.slice(ab));
  if (!hit) return source.length;
  return tagEnde(source, ab + hit.index);
}

/**
 * Macht aus ungeprüftem HTML genau die fünf erlaubten Auszeichnungen.
 *
 * Der Rückgabewert ist ein FRAGMENT (kein vollständiges Dokument) und immer
 * ausgeglichen: Offene Auszeichnungen werden am Ende geschlossen, verirrte
 * schliessende Tags verworfen. Kaputtes HTML kann damit nicht in den Rahmen
 * hineinreichen und dessen Aufbau zerlegen — ein `<strong` ohne `>` in der
 * Redaktion würde sonst die Fusszeile mitfetten.
 */
export function sanitize(raw: string): string {
  const source = raw.replace(INVISIBLE, '');
  const parts: string[] = [];
  const batch: string[] = [];
  let i = 0;

  const closeUntil = (name: string): void => {
    const stelle = batch.lastIndexOf(name);
    if (stelle < 0) return;
    while (batch.length > stelle) parts.push(`</${batch.pop()}>`);
  };

  while (i < source.length) {
    const spitz = source.indexOf('<', i);
    if (spitz < 0) {
      parts.push(escapeContent(source.slice(i)));
      break;
    }
    if (spitz > i) parts.push(escapeContent(source.slice(i, spitz)));

    // Kommentare, Doctype und Verarbeitungsanweisungen: restlos weg.
    if (source.startsWith('<!--', spitz)) {
      const ende = source.indexOf('-->', spitz + 4);
      i = ende < 0 ? source.length : ende + 3;
      continue;
    }
    if (source.startsWith('<!', spitz) || source.startsWith('<?', spitz)) {
      i = tagEnde(source, spitz);
      continue;
    }

    const tag = readTag(source, spitz);
    if (tag === null) {
      // Ein `<`, hinter dem kein Tagname steht — also Text. Etwa „3 < 5".
      parts.push('&lt;');
      i = spitz + 1;
      continue;
    }

    if (!tag.completed) {
      // Abgeschnitten am Ende der Eingabe — wie im Browser: verwerfen.
      i = source.length;
      continue;
    }

    if (!(ALLOWED_TAGS as readonly string[]).includes(tag.name)) {
      i =
        CONTENT_DISCARD.has(tag.name) && !tag.closing
          ? skipContent(source, tag.further, tag.name)
          : tag.further;
      continue;
    }

    i = tag.further;
    if (EMPTY_TAGS.has(tag.name)) {
      // `</br>` gibt es nicht; es wird still verworfen.
      if (!tag.closing) parts.push(`<${tag.name}>`);
      continue;
    }
    if (tag.closing) {
      closeUntil(tag.name);
      continue;
    }
    // Ein Absatz beendet den vorigen — `<p>` darf nicht in `<p>` liegen.
    if (tag.name === 'p') closeUntil('p');
    if (batch.length >= MAX_DEPTH) continue;
    batch.push(tag.name);
    parts.push(`<${tag.name}>`);
  }

  while (batch.length > 0) parts.push(`</${batch.pop()}>`);
  return parts.join('');
}

/** Die benannten Entitäten, die `textAus` zurückverwandelt. */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
};

/** Macht aus `&amp;`, `&#39;` und `&#x27;` wieder Zeichen. */
function decrypt(value: string): string {
  return value.replace(
    /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (whole: string, core: string) => {
      if (core.startsWith('#')) {
        const number =
          core[1] === 'x' || core[1] === 'X'
            ? Number.parseInt(core.slice(2), 16)
            : Number.parseInt(core.slice(1), 10);
        if (!Number.isFinite(number) || number < 32 || number > 0x10ffff) return '';
        return String.fromCodePoint(number);
      }
      const replacement = NAMED[core.toLowerCase()];
      return replacement === undefined ? whole : replacement;
    },
  );
}

/**
 * Leitet den TEXTTEIL aus dem gesäuberten HTML ab.
 *
 * Der Textteil ist nicht optional und nicht „später": Viele Spamfilter lesen
 * ihn zuerst, manche Programme zeigen ausschliesslich ihn an, und eine Mail
 * ohne ihn ist ein Zustellungsrisiko. Weil er aus DEMSELBEN HTML entsteht,
 * kann er inhaltlich nicht davon abweichen.
 *
 * Absätze werden zu Leerzeilen, `<br>` zu einem Umbruch, Auszeichnungen fallen
 * ersatzlos weg: Sternchen um fette Wörter wären eine Erfindung des Servers
 * und stünden im Weg, wenn im Text ohnehin schon welche vorkommen.
 */
export function textFrom(html: string): string {
  const withWraps = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return decrypt(withWraps)
    .split('\n')
    .map((row) => row.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Der umgekehrte Weg: aus REINEM TEXT ein erlaubtes HTML-Fragment.
 *
 * Gebraucht für alle Mails, deren Wortlaut im Quelltext steht (Anmeldecode,
 * Rechnung, Bestätigungsmail) und für Vorlagen aus der Zeit vor dem
 * Redaktionsfeld. Leerzeile trennt Absätze, einfacher Umbruch wird `<br>`.
 */
export function htmlFromText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ''))
    .filter((paragraph) => paragraph.trim() !== '')
    .map((paragraph) => `<p>${escapeContent(paragraph).split('\n').join('<br>')}</p>`)
    .join('');
}
