// Textauszug und Bildzählung für PDFs (Suite "invoice"). Läuft im Java-Quelltextmodus:
//   java -cp mustang-cli.jar PdfText.java <Ausgabeordner> <datei.pdf> [...]
// Die Mustangproject-CLI bringt PDFBox 3 mit; das Rechnungsdienst-Image enthält sie unter /opt/mustang-cli.jar.
// Je PDF entsteht <Ausgabeordner>/<Name>.txt; auf stdout steht je PDF eine Zeile "IMAGES <Name> <Anzahl>" und "FONTS <Name> <Schriften,...>".
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Set;
import java.util.TreeSet;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.text.PDFTextStripper;

public class PdfText {
  static int images(PDResources res) throws Exception {
    if (res == null) return 0;
    int n = 0;
    for (COSName name : res.getXObjectNames()) {
      PDXObject x = res.getXObject(name);
      if (x instanceof PDImageXObject) n++;
      else if (x instanceof PDFormXObject) n += images(((PDFormXObject) x).getResources());
    }
    return n;
  }

  /** Schriftnamen (BaseFont/FontName) aus den Rohdaten; PDFBox liefert für eingebettete CID-Schriften keinen Namen. */
  static Set<String> fonts(File pdf) throws Exception {
    String raw = new String(Files.readAllBytes(pdf.toPath()), StandardCharsets.ISO_8859_1);
    Set<String> out = new TreeSet<>();
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("/(?:BaseFont|FontName)\\s*/([A-Za-z0-9+_-]+)").matcher(raw);
    while (m.find()) out.add(m.group(1));
    return out;
  }

  public static void main(String[] args) throws Exception {
    File out = new File(args[0]);
    out.mkdirs();
    for (int i = 1; i < args.length; i++) {
      File pdf = new File(args[i]);
      try (PDDocument doc = Loader.loadPDF(pdf)) {
        PDFTextStripper stripper = new PDFTextStripper();
        // Reihenfolge des Inhaltsstroms (= Reihenfolge im HTML): Spalten der Fußzeile bleiben je Spalte zusammenhängend.
        stripper.setSortByPosition(false);
        String text = stripper.getText(doc);
        String base = pdf.getName().replaceAll("\\.pdf$", "");
        Files.writeString(new File(out, base + ".txt").toPath(), text, StandardCharsets.UTF_8);
        int imgs = 0;
        for (PDPage page : doc.getPages()) imgs += images(page.getResources());
        System.out.println("IMAGES " + base + " " + imgs);
        System.out.println("FONTS " + base + " " + String.join(",", fonts(pdf)));
      }
    }
  }
}
