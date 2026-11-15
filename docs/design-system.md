# Design-System

Neutral, sachlich, nicht gebrandet: für beliebige Zwecke einsetzbar. Einzige Quelle der Wahrheit ist `packages/ui/src/tokens.css`. Komponenten nutzen nur Tokens, keine Roh-Hex-Werte.

## Schrift

Eine Familie: **Inter** (Variable), selbst gehostet über `@fontsource-variable/inter` (`packages/ui/src/fonts.ts`), keine Verbindung zu Google Fonts. Basis 16 px, Zeilenhöhe 1.5. Tabellarische Ziffern (`font-variant-numeric: tabular-nums`) in Tabellen, `<time>` und mit der Klasse `.ziffern-tabellarisch`. `--font-serif` bleibt als Alias auf die Sans-Familie bestehen, damit alte Verweise nicht brechen. Überschriften werden nur über das Gewicht (600) abgesetzt.

Die öffentlichen Server-Seiten (`consent/pages.ts`) laden Inter über `public/fonts/` (`pnpm --filter @saas-instant/control fonts`).

## Palette (Hell)

| Rolle | Token | Hex | Kontrast |
|---|---|---|---|
| Hintergrund | `--farbe-flaeche-2` | `#f8fafc` | Text darauf 17.06:1 |
| Fläche | `--farbe-flaeche` | `#ffffff` | Text darauf 17.85:1 |
| Rahmen | `--farbe-rahmen` | `#e2e8f0` | dekorativ |
| Rahmen Eingabefeld | `--farbe-rahmen-ui` | `#7b8aa0` | UI >= 3:1 auf Weiß |
| Text | `--farbe-text` | `#0f172a` | 17.85:1 auf Weiß |
| Sekundärtext | `--farbe-text-leise` | `#475569` | 7.58:1 auf Weiß |
| Tertiärtext | `--farbe-text-still` | `#5b6b82` | 5.43:1 auf Weiß |
| Akzent | `--farbe-primaer` | `#0369a1` | 5.93:1 auf Weiß; Weiß darauf 5.93:1 |
| Akzent Hover | `--farbe-primaer-hover` | `#075985` | Weiß darauf 7.56:1 |
| Akzent weich | `--farbe-primaer-soft` | `#e0f2fe` | `#075985` darauf 6.59:1 |
| Gefahr | `--farbe-gefahr` | `#b91c1c` | Weiß darauf 6.47:1 |
| Erfolg | `--farbe-erfolg-bg/-rahmen/-text` | `#f0fdf4` / `#15803d` / `#166534` | Text AA |
| Warnung | `--farbe-warnung-bg/-rahmen/-text` | `#fffbeb` / `#b45309` / `#92400e` | Text AA |
| Gefahr (Hinweis) | `--farbe-gefahr-bg/-rahmen/-bg-text` | `#fef2f2` / `#b91c1c` / `#991b1b` | Text AA |

Die Eintragsfarben (`--e-vorschlag|bedenken|einwand|beschluss-*`) folgen derselben Semantik: Info (Akzent), Warnung, Gefahr, Erfolg. Farbe ist nie alleiniges Signal: Icon oder Label steht immer dabei.

Die vollständige Prüfung (alle Paare, Hell und Dunkel, Text >= 4.5:1, UI >= 3:1) läuft mit:

```
node scripts/contrast-check.mjs          # Exit 1 bei Verstoß
node scripts/contrast-check.mjs --table  # zusätzlich als Markdown-Tabelle
```

Der Stand beim letzten Lauf: 142 Paare bestanden. Das Skript prüft außerdem, dass beide Dunkel-Blöcke identisch sind.

## Dunkelmodus

Automatisch über `prefers-color-scheme: dark` (`:root:not([data-theme="light"])`), manuell überschreibbar am `<html>`-Element mit `data-theme="light"` oder `data-theme="dark"`. Es werden nur Token-Werte getauscht (Slate 900/800 als Flächen, Akzent `#38bdf8` mit dunklem Text `#082f49`, Semantikfarben als helle Töne auf dunklem Grund). `color-scheme` folgt dem Modus. Die Dunkelwerte stehen aus CSS-Gründen zweimal in `tokens.css`; das Kontrast-Skript meldet Abweichungen.

## Fokus und Bedienung

- Sichtbarer Fokusring: 2 px, `--farbe-fokus` (Akzent), 2 px Abstand, auf allen interaktiven Elementen.
- Touch-Ziele mindestens 44 px (`--touch-ziel`) bei `pointer: coarse` für Buttons, Selects und Eingabefelder.
- Übergänge 150 ms (`--uebergang`), lange 200 ms; `prefers-reduced-motion` setzt sie praktisch auf null.
- Keine dekorative Animation, Icons nur als SVG (lucide), keine Emoji.

## Abstände, Radius, Schatten

- Abstandsskala 4/8 px: `--abstand-1` (4), `-2` (8), `-3` (12), `-4` (16), `-6` (24), `-8` (32); Tailwind-Utilities folgen derselben 4-px-Basis.
- Radius klein: 4 bis 8 px (`rounded-md` 6 px, `rounded-lg` und größer 8 px, `--radius-klein`, `--radius-mittel`).
- Schatten dezent (`--schatten-karte`, `-popover`, `-dialog`, `-toast`, `-segment`), im Dunkelmodus kräftiger, weil sonst unsichtbar.

## Bekannte Ausnahmen

- E-Mail-Layout (`packages/shared/src/mail-layout.ts`) und öffentliche Server-Seiten tragen Abschriften der Hell-Werte; Tests halten sie gegen `tokens.css`. Die Mail nutzt weiterhin Systemschriften (Georgia für die Wortmarke), weil Postfächer keine Webfonts laden.
- Rechnungs-PDF (`invoices/document/layout-html.ts`) ist ein Druckdokument mit eigenem Schwarz-Grau-Stylesheet.
