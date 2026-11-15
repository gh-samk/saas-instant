// InvoiceService — bettet ZUGFeRD-XML in ein PDF ein und macht daraus PDF/A-3.
//
// WARUM ES DIESES PROGRAMM GIBT
// Die Mustang-Befehlszeile (--action combine) verlangt, dass das Eingabe-PDF
// bereits PDF/A-1 oder PDF/A-3 ist. Sie bricht sonst mit
// "PDF-A version not supported" ab; weder -i noch --ignorefileextension
// helfen. Ein von Chromium gedrucktes PDF ist kein PDF/A. Die Mustang-
// BIBLIOTHEK kann dagegen genau das: ZUGFeRDExporterFromA1 mit
// ignorePDFAErrors() nimmt ein gewoehnliches PDF, ergaenzt XMP-Metadaten,
// das sRGB-OutputIntent und die Trailer-ID und schreibt PDF/A-3.
// Damit entfaellt der Umweg ueber Ghostscript — und dessen AGPL.
//
// KEIN RAHMENWERK
// Der HTTP-Teil benutzt den in jedem JDK enthaltenen
// com.sun.net.httpserver.HttpServer. Das Programm hat damit ausser
// Mustangproject (Apache 2.0) keine Abhaengigkeit und wird mit einem
// einzigen javac-Aufruf uebersetzt.
//
// Uebersetzen:
//   javac -cp /opt/mustang-cli.jar -d /opt/dienst InvoiceService.java
// Aufrufen:
//   java -cp /opt/mustang-cli.jar:/opt/dienst InvoiceService einbetten a.pdf b.xml c.pdf
//   java -cp /opt/mustang-cli.jar:/opt/dienst InvoiceService dienst 8080

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.mustangproject.ZUGFeRD.PDFAConformanceLevel;
import org.mustangproject.ZUGFeRD.ZUGFeRDExporterFromA1;
import org.mustangproject.validator.ZUGFeRDValidator;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class InvoiceService {

  /** Groesste zulaessige Anfrage. Schuetzt vor Speicherhunger durch Fremde. */
  private static final int HOECHSTGROESSE = 20 * 1024 * 1024;

  /**
   * Prueft der Dienst jedes erzeugte PDF selbst nach, bevor er es herausgibt?
   *
   * Standard ist ja. Mustangproject bringt veraPDF als Bibliothek mit; die
   * Pruefung kostet rund eine Sekunde und deckt beide Abnahmekriterien ab:
   * PDF/A-3b und ZUGFeRD EN 16931. Damit kann keine ungueltige Rechnung den
   * Dienst verlassen — auch nicht, wenn spaeter jemand das Layout aendert und
   * dabei aus Versehen eine nicht einbettbare Schrift verwendet.
   * Abschaltbar ueber RECHNUNG_SELBSTPRUEFUNG=0.
   */
  private static final boolean SELBSTPRUEFUNG =
      !"0".equals(System.getenv("RECHNUNG_SELBSTPRUEFUNG"));

  /** Pfad zum Browser, der das sichtbare Dokument setzt. */
  private static final String BROWSER =
      System.getenv().getOrDefault("RECHNUNG_BROWSER", "/usr/bin/chromium");

  /**
   * Chromium-Sandbox einschalten (RECHNUNG_BROWSER_SANDBOX=1)? Vorgabe: aus.
   *
   * Die Sandbox braucht unprivilegierte User-Namespaces. Docker sperrt sie in
   * seinem Standardprofil (seccomp) und mit cap_drop ALL; Chromium startet
   * dann ohne --no-sandbox gar nicht. Wer sein Laufzeitumfeld entsprechend
   * freigibt (eigenes seccomp-Profil), kann die Sandbox hiermit anschalten.
   */
  private static final boolean BROWSER_SANDBOX =
      "1".equals(System.getenv("RECHNUNG_BROWSER_SANDBOX"));

  /** Abbruch, falls der Browser haengt. */
  private static final int BROWSER_ZEITGRENZE_SEKUNDEN = 30;

  /** Erlaubte Profile. Alles andere wird abgewiesen statt stillschweigend ersetzt. */
  private static final java.util.Set<String> PROFILE =
      java.util.Set.of("MINIMUM", "BASICWL", "BASIC", "CIUS", "EN16931", "XRECHNUNG", "EXTENDED");

  private InvoiceService() {}

  // ---------------------------------------------------------------- Kern ---

  /**
   * Bettet das ZUGFeRD-XML in das PDF ein und liefert ein PDF/A-3b zurueck.
   *
   * @param pdf     beliebiges PDF, muss KEIN PDF/A sein
   * @param xml     CII-XML nach EN 16931
   * @param profil  Profilname, siehe PROFILE
   */
  static byte[] einbetten(byte[] pdf, byte[] xml, String profil) throws IOException {
    if (pdf == null || pdf.length == 0) {
      throw new IllegalArgumentException("Das PDF fehlt oder ist leer.");
    }
    if (xml == null || xml.length == 0) {
      throw new IllegalArgumentException("Das XML fehlt oder ist leer.");
    }
    if (pdf.length < 5 || pdf[0] != '%' || pdf[1] != 'P' || pdf[2] != 'D' || pdf[3] != 'F') {
      throw new IllegalArgumentException("Die uebergebenen Daten beginnen nicht mit %PDF.");
    }
    if (!PROFILE.contains(profil)) {
      throw new IllegalArgumentException(
          "Unbekanntes Profil: " + profil + ". Erlaubt: " + PROFILE);
    }

    ZUGFeRDExporterFromA1 ausgeber =
        new ZUGFeRDExporterFromA1()
            .setProducer("saas-instant invoice renderer")
            .setCreator("saas-instant")
            .setConformanceLevel(PDFAConformanceLevel.BASIC)
            .setZUGFeRDVersion(2)
            .setProfile(profil);
    // Ohne diesen Aufruf lehnt Mustang jedes Eingabe-PDF ab, das nicht schon
    // PDF/A ist. Mit ihm ergaenzt es die fehlenden Pflichtangaben selbst.
    ausgeber.ignorePDFAErrors();
    ausgeber.load(pdf);
    ausgeber.setXML(xml);

    ByteArrayOutputStream ziel = new ByteArrayOutputStream(pdf.length + xml.length + 65536);
    ausgeber.export(ziel);
    return ziel.toByteArray();
  }

  /**
   * Setzt HTML zu einem PDF. Der Browser laeuft dabei bewusst eingeschraenkt:
   *
   *   --host-resolver-rules=MAP * ~NOTFOUND
   *       kappt jede Namensaufloesung. Ein Bild, ein Stylesheet oder eine
   *       Schrift von einer fremden Adresse wird damit nicht geladen. Das ist
   *       kein Komfortverzicht, sondern die Absicherung: das Rechnungs-HTML
   *       enthaelt Kundendaten, und ohne diese Sperre koennte eine
   *       hineingeratene Fremdadresse sie nach draussen tragen.
   *   --no-sandbox (nur ohne RECHNUNG_BROWSER_SANDBOX=1)
   *       im Standard-Container unvermeidlich, siehe BROWSER_SANDBOX. Ausgleich:
   *       der Dienst laeuft nicht als root, ohne Netzzugang-Bedarf und mit
   *       gekappter Namensaufloesung (siehe Dockerfile und README.md).
   *   --user-data-dir
   *       liegt im Anfrageverzeichnis unter /tmp. Das Wurzeldateisystem des
   *       Containers ist im Betrieb schreibgeschuetzt.
   *
   * Das HTML wird in ein eigenes, nur fuer diesen Aufruf angelegtes
   * Verzeichnis geschrieben und danach samt Inhalt geloescht.
   */
  static byte[] rendere(byte[] html) throws IOException, InterruptedException {
    if (html == null || html.length == 0) {
      throw new IllegalArgumentException("Das HTML fehlt oder ist leer.");
    }
    Path verzeichnis = Files.createTempDirectory("rechnung-");
    try {
      Path quelle = verzeichnis.resolve("rechnung.html");
      Path ziel = verzeichnis.resolve("rechnung.pdf");
      Files.write(quelle, html);

      java.util.List<String> befehl = new java.util.ArrayList<>();
      befehl.add(BROWSER);
      befehl.add("--headless=new");
      if (!BROWSER_SANDBOX) {
        befehl.add("--no-sandbox");
      }
      befehl.addAll(
          java.util.List.of(
                  // Ohne eigenes Profilverzeichnis legt Chromium eines unter
                  // $HOME an. Im Betrieb laeuft der Container mit
                  // read_only: true — dann scheitert der Start mit
                  // "Failed to create headless user data directory container",
                  // und zwar erst bei der ersten echten Rechnung.
                  "--user-data-dir=" + verzeichnis.resolve("browser").toAbsolutePath(),
                  "--crash-dumps-dir=" + verzeichnis.resolve("browser").toAbsolutePath(),
                  "--disable-gpu",
                  "--disable-dev-shm-usage",
                  "--host-resolver-rules=MAP * ~NOTFOUND",
                  "--run-all-compositor-stages-before-draw",
                  "--virtual-time-budget=10000",
                  "--no-pdf-header-footer",
                  "--print-to-pdf=" + ziel.toAbsolutePath(),
                  quelle.toUri().toString()));
      Process browser = new ProcessBuilder(befehl).redirectErrorStream(true).start();
      String ausgabe = new String(browser.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      if (!browser.waitFor(BROWSER_ZEITGRENZE_SEKUNDEN, java.util.concurrent.TimeUnit.SECONDS)) {
        browser.destroyForcibly();
        throw new IOException("Der Browser hat nicht innerhalb der Zeitgrenze geantwortet.");
      }
      if (!Files.exists(ziel) || Files.size(ziel) == 0) {
        throw new IOException("Der Browser hat kein PDF geschrieben. Ausgabe: " + ausgabe);
      }
      return Files.readAllBytes(ziel);
    } finally {
      loescheBaum(verzeichnis);
    }
  }

  private static void loescheBaum(Path wurzel) {
    try (var pfade = Files.walk(wurzel)) {
      pfade.sorted(java.util.Comparator.reverseOrder())
          .forEach(
              pfad -> {
                try {
                  Files.deleteIfExists(pfad);
                } catch (IOException ignoriert) {
                  // Ein Rest im Temp-Verzeichnis ist kein Grund, die Rechnung
                  // scheitern zu lassen.
                }
              });
    } catch (IOException ignoriert) {
      // dito
    }
  }

  /** Ergebnis einer Nachpruefung: Bericht plus das schlichte Ja/Nein. */
  record Pruefergebnis(boolean gueltig, String bericht) {}

  /**
   * Laesst Mustang die Daten pruefen: XSD, Schematron EN 16931 und — bei
   * einem PDF — zusaetzlich die PDF/A-Konformitaet ueber das mitgelieferte
   * veraPDF.
   */
  static Pruefergebnis pruefen(byte[] daten, String name) {
    ZUGFeRDValidator pruefer = new ZUGFeRDValidator();
    String bericht = pruefer.validate(daten, name);
    return new Pruefergebnis(pruefer.wasCompletelyValid(), bericht);
  }

  // --------------------------------------------------------- Befehlszeile ---

  public static void main(String[] argumente) throws Exception {
    if (argumente.length == 0) {
      hilfe();
      System.exit(2);
    }
    switch (argumente[0]) {
      case "einbetten" -> {
        if (argumente.length < 4) {
          hilfe();
          System.exit(2);
        }
        String profil = argumente.length > 4 ? argumente[4] : "EN16931";
        byte[] ergebnis =
            einbetten(
                Files.readAllBytes(Path.of(argumente[1])),
                Files.readAllBytes(Path.of(argumente[2])),
                profil);
        Files.write(Path.of(argumente[3]), ergebnis);
        System.out.println("geschrieben: " + argumente[3] + " (" + ergebnis.length + " Bytes)");
        if (SELBSTPRUEFUNG) {
          Pruefergebnis nachpruefung = pruefen(ergebnis, argumente[3]);
          System.out.println("Nachpruefung: " + (nachpruefung.gueltig() ? "gueltig" : "UNGUELTIG"));
          if (!nachpruefung.gueltig()) {
            System.out.println(nachpruefung.bericht());
            System.exit(1);
          }
        }
      }
      case "erzeuge" -> {
        if (argumente.length < 4) {
          hilfe();
          System.exit(2);
        }
        String profil = argumente.length > 4 ? argumente[4] : "EN16931";
        byte[] pdf = rendere(Files.readAllBytes(Path.of(argumente[1])));
        byte[] ergebnis = einbetten(pdf, Files.readAllBytes(Path.of(argumente[2])), profil);
        Files.write(Path.of(argumente[3]), ergebnis);
        System.out.println("geschrieben: " + argumente[3] + " (" + ergebnis.length + " Bytes)");
        if (SELBSTPRUEFUNG) {
          Pruefergebnis nachpruefung = pruefen(ergebnis, argumente[3]);
          System.out.println("Nachpruefung: " + (nachpruefung.gueltig() ? "gueltig" : "UNGUELTIG"));
          if (!nachpruefung.gueltig()) {
            System.out.println(nachpruefung.bericht());
            System.exit(1);
          }
        }
      }
      case "pruefen" -> {
        if (argumente.length < 2) {
          hilfe();
          System.exit(2);
        }
        Pruefergebnis ergebnis =
            pruefen(Files.readAllBytes(Path.of(argumente[1])), argumente[1]);
        System.out.println(ergebnis.bericht());
        System.exit(ergebnis.gueltig() ? 0 : 1);
      }
      case "dienst" -> starteDienst(argumente.length > 1 ? Integer.parseInt(argumente[1]) : 8080);
      default -> {
        hilfe();
        System.exit(2);
      }
    }
  }

  private static void hilfe() {
    System.err.println(
        """
        InvoiceService
          erzeuge   <rechnung.html> <factur-x.xml> <ausgabe.pdf> [Profil]
          einbetten <eingabe.pdf>   <factur-x.xml> <ausgabe.pdf> [Profil]
          pruefen   <datei.pdf|datei.xml>       Rueckgabewert 0 = gueltig
          dienst    [Port]
        """);
  }

  // ----------------------------------------------------------------- HTTP ---

  private static void starteDienst(int port) throws IOException {
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
    server.setExecutor(Executors.newFixedThreadPool(4));

    // Betriebsanzeige. Bewusst ohne Fremdtext und ohne Angaben zur Fassung
    // der eingesetzten Bibliotheken: der Weg ist offen erreichbar.
    server.createContext(
        "/gesundheit",
        austausch -> {
          if (!"GET".equals(austausch.getRequestMethod())) {
            antworte(austausch, 405, "text/plain; charset=utf-8", "Nur GET.".getBytes(StandardCharsets.UTF_8));
            return;
          }
          antworte(austausch, 200, "application/json; charset=utf-8",
              "{\"status\":\"bereit\"}".getBytes(StandardCharsets.UTF_8));
        });

    // /erzeuge ist der Weg, den das Rechnungsmodul benutzt: HTML rein,
    // fertiges PDF/A-3b raus. /einbetten bleibt fuer den Fall, dass das PDF
    // anderswo entsteht.
    server.createContext("/erzeuge", austausch -> behandle(austausch, true));
    server.createContext("/einbetten", austausch -> behandle(austausch, false));

    server.start();
    System.out.println("InvoiceService hoert auf Port " + port);
  }

  /**
   * POST /einbetten
   * Rumpf: {"pdf":"<base64>","xml":"<base64>","profil":"EN16931"}
   * Antwort: das fertige PDF/A-3b als application/pdf.
   *
   * Der Rumpf wird bewusst mit einem festen Muster gelesen statt mit einem
   * JSON-Leser: die drei Felder enthalten ausschliesslich Base64 bzw. einen
   * Profilnamen, beide ohne Anfuehrungszeichen und ohne Fluchtzeichen. Alles,
   * was nicht genau auf dieses Muster passt, wird abgewiesen. Das ist enger
   * als ein echter JSON-Leser — und spart die Abhaengigkeit.
   */
  private static void behandle(HttpExchange austausch, boolean rendern) throws IOException {
    try {
      if (!"POST".equals(austausch.getRequestMethod())) {
        fehler(austausch, 405, "methode_nicht_erlaubt", "Nur POST.");
        return;
      }
      byte[] rumpf = liesBegrenzt(austausch.getRequestBody());
      String text = new String(rumpf, StandardCharsets.UTF_8);

      String eingangsfeld = rendern ? "html" : "pdf";
      String eingangB64 = feld(text, eingangsfeld);
      String xmlB64 = feld(text, "xml");
      String profil = feld(text, "profil");
      if (eingangB64 == null || xmlB64 == null) {
        fehler(austausch, 400, "unvollstaendig",
            "Erwartet wird {'" + eingangsfeld + "':'<base64>','xml':'<base64>'}.");
        return;
      }
      if (profil == null || profil.isBlank()) {
        profil = "EN16931";
      }
      profil = profil.toUpperCase(Locale.ROOT);

      byte[] eingang;
      byte[] xml;
      try {
        eingang = Base64.getDecoder().decode(eingangB64);
        xml = Base64.getDecoder().decode(xmlB64);
      } catch (IllegalArgumentException ungueltig) {
        fehler(austausch, 400, "kein_base64", eingangsfeld + " und xml muessen Base64 sein.");
        return;
      }

      byte[] ergebnis;
      try {
        byte[] pdf = rendern ? rendere(eingang) : eingang;
        ergebnis = einbetten(pdf, xml, profil);
      } catch (IllegalArgumentException ungueltig) {
        fehler(austausch, 400, "eingabe_ungueltig", ungueltig.getMessage());
        return;
      } catch (InterruptedException unterbrochen) {
        Thread.currentThread().interrupt();
        fehler(austausch, 503, "abgebrochen", "Die Erzeugung wurde unterbrochen.");
        return;
      }

      if (SELBSTPRUEFUNG) {
        Pruefergebnis nachpruefung = pruefen(ergebnis, "rechnung.pdf");
        if (!nachpruefung.gueltig()) {
          // Der Pruefbericht geht mit, weil er der einzige Weg ist, die
          // Ursache zu finden — er enthaelt keine Angaben ueber den Aufrufer,
          // nur ueber das gerade erzeugte Dokument.
          austausch.getResponseHeaders().set("Content-Type", "application/xml; charset=utf-8");
          byte[] bericht = nachpruefung.bericht().getBytes(StandardCharsets.UTF_8);
          austausch.sendResponseHeaders(422, bericht.length);
          try (OutputStream aus = austausch.getResponseBody()) {
            aus.write(bericht);
          }
          return;
        }
      }
      antworte(austausch, 200, "application/pdf", ergebnis);

    } catch (ZuGross zuGross) {
      fehler(austausch, 413, "zu_gross", "Hoechstens " + HOECHSTGROESSE + " Bytes.");
    } catch (Exception unerwartet) {
      // Der Text der Ausnahme kann Dateipfade enthalten und geht deshalb nur
      // ins Protokoll, nicht an den Aufrufer.
      unerwartet.printStackTrace();
      fehler(austausch, 500, "einbetten_fehlgeschlagen",
          "Das PDF konnte nicht erzeugt werden.");
    }
  }

  /** Einheitliches Fehlerformat des Projekts. */
  private static void fehler(HttpExchange austausch, int code, String kennung, String nachricht)
      throws IOException {
    String rumpf =
        "{\"fehler\":{\"code\":\"" + kennung + "\",\"nachricht\":\"" + nachricht.replace("\"", "'") + "\"}}";
    antworte(austausch, code, "application/json; charset=utf-8", rumpf.getBytes(StandardCharsets.UTF_8));
  }

  private static void antworte(HttpExchange austausch, int code, String typ, byte[] rumpf)
      throws IOException {
    austausch.getResponseHeaders().set("Content-Type", typ);
    austausch.sendResponseHeaders(code, rumpf.length);
    try (OutputStream aus = austausch.getResponseBody()) {
      aus.write(rumpf);
    }
  }

  private static final class ZuGross extends IOException {
    ZuGross() {
      super("Anfrage zu gross");
    }
  }

  private static byte[] liesBegrenzt(InputStream ein) throws IOException {
    ByteArrayOutputStream puffer = new ByteArrayOutputStream();
    byte[] block = new byte[16384];
    int gelesen;
    while ((gelesen = ein.read(block)) != -1) {
      if (puffer.size() + gelesen > HOECHSTGROESSE) {
        throw new ZuGross();
      }
      puffer.write(block, 0, gelesen);
    }
    return puffer.toByteArray();
  }

  private static String feld(String text, String name) {
    Matcher treffer =
        Pattern.compile("\"" + name + "\"\\s*:\\s*\"([A-Za-z0-9+/=_-]*)\"").matcher(text);
    return treffer.find() ? treffer.group(1) : null;
  }
}
