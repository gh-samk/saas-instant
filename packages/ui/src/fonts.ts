/**
 * Schriften des Design-Systems als Seiteneffekt-Import.
 *
 * Der Import muss VOR dem CSS-Import der App stehen, damit die Reihenfolge im
 * gebauten Bundle stimmt.
 *
 * Eine einzige Familie: Inter (Variable, selbst gehostet über Fontsource,
 * keine Verbindung zu Google Fonts). In `tokens.css` als `--font-sans`
 * hinterlegt; `--font-serif` zeigt auf dieselbe Familie.
 */
import '@fontsource-variable/inter';
