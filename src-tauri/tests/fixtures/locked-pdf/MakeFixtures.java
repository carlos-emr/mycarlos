// Makes the FAKE test PDFs for myCarlos #54 with PDFBox 3.0.8, the version
// CARLOS ships. Encryption follows CARLOS's PDFEncryptionUtil: a
// StandardProtectionPolicy with the same user and owner password and default
// permissions. Run: java -cp <pdfbox, pdfbox-io, fontbox, commons-logging>
// MakeFixtures.java <output directory>
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.encryption.AccessPermission;
import org.apache.pdfbox.pdmodel.encryption.StandardProtectionPolicy;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget;
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;

public class MakeFixtures {
    static final String PASSWORD = "FAKE-portal-2026";
    static final String NON_ASCII = "FAKE-mot-de-passe-éàç-Łódź-日本";

    public static void main(String[] args) throws Exception {
        Path out = Path.of(args[0]);
        Files.createDirectories(out);
        Path text = out.resolve("text-original.pdf");
        Path image = out.resolve("image-original.pdf");
        Path form = out.resolve("form-original.pdf");
        Path eform = out.resolve("eform-original.pdf");
        writeText(text);
        writeImage(image);
        writeForm(form);
        writeEform(eform);
        // As CARLOS sends them: AES-256, revision 6.
        protect(text, out.resolve("text-aes256.pdf"), PASSWORD, 256, true);
        protect(image, out.resolve("image-aes256.pdf"), PASSWORD, 256, true);
        protect(form, out.resolve("form-aes256.pdf"), PASSWORD, 256, true);
        protect(eform, out.resolve("eform-aes256.pdf"), PASSWORD, 256, true);
        protect(text, out.resolve("text-aes256-non-ascii.pdf"), NON_ASCII, 256, true);
        // Older schemes another sender might use.
        protect(text, out.resolve("text-aes128.pdf"), PASSWORD, 128, true);
        protect(text, out.resolve("text-rc4-128.pdf"), PASSWORD, 128, false);
        protect(text, out.resolve("text-rc4-40.pdf"), PASSWORD, 40, false);
        // Cut short: a damaged download.
        byte[] whole = Files.readAllBytes(out.resolve("text-aes256.pdf"));
        Files.write(out.resolve("text-aes256-damaged.pdf"), Arrays.copyOf(whole, whole.length * 3 / 5));
    }

    static PDFont helvetica() {
        return new PDType1Font(Standard14Fonts.FontName.HELVETICA);
    }

    static void line(PDPageContentStream content, PDFont font, float size, float x, float y, String text)
            throws Exception {
        content.beginText();
        content.setFont(font, size);
        content.newLineAtOffset(x, y);
        content.showText(text);
        content.endText();
    }

    static void writeText(Path path) throws Exception {
        try (PDDocument document = new PDDocument()) {
            PDFont font = helvetica();
            for (int number = 1; number <= 2; number++) {
                PDPage page = new PDPage(PDRectangle.LETTER);
                document.addPage(page);
                try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                    line(content, font, 16, 72, 700, "FAKE Clinic - test document, not a real record");
                    line(content, font, 12, 72, 670, "Patient: FAKE Avery Example");
                    line(content, font, 12, 72, 650, "FAKE Hemoglobin 140 g/L (made-up value)");
                    line(content, font, 12, 72, 630, "Page " + number + " of 2");
                }
            }
            document.save(path.toFile());
        }
    }

    static void writeImage(Path path) throws Exception {
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage(PDRectangle.LETTER);
            document.addPage(page);
            BufferedImage picture = new BufferedImage(64, 64, BufferedImage.TYPE_INT_RGB);
            for (int x = 0; x < 64; x++)
                for (int y = 0; y < 64; y++)
                    picture.setRGB(x, y, new Color(x * 4, y * 4, 128).getRGB());
            PDImageXObject xobject = LosslessFactory.createFromImage(document, picture);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                line(content, helvetica(), 12, 72, 700, "FAKE scan with a made-up picture");
                content.drawImage(xobject, 72, 500, 128, 128);
            }
            document.save(path.toFile());
        }
    }

    static void writeForm(Path path) throws Exception {
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage(PDRectangle.LETTER);
            document.addPage(page);
            PDAcroForm form = new PDAcroForm(document);
            document.getDocumentCatalog().setAcroForm(form);
            PDResources resources = new PDResources();
            resources.put(COSName.HELV, helvetica());
            form.setDefaultResources(resources);
            form.setDefaultAppearance("/Helv 0 Tf 0 g");
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                line(content, helvetica(), 12, 72, 700, "FAKE intake form");
            }
            String[][] fields = {{"fake_name", "FAKE Avery Example"}, {"fake_note", "FAKE note, made up"}};
            float top = 650;
            for (String[] field : fields) {
                PDTextField box = new PDTextField(form);
                box.setPartialName(field[0]);
                box.setDefaultAppearance("/Helv 12 Tf 0 g");
                form.getFields().add(box);
                PDAnnotationWidget widget = box.getWidgets().get(0);
                widget.setRectangle(new PDRectangle(72, top, 300, 20));
                widget.setPage(page);
                page.getAnnotations().add(widget);
                box.setValue(field[1]);
                top -= 40;
            }
            document.save(path.toFile());
        }
    }

    // A CARLOS eForm arrives as its page printed to PDF: text and ruled boxes.
    static void writeEform(Path path) throws Exception {
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage(PDRectangle.LETTER);
            document.addPage(page);
            PDFont font = helvetica();
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                line(content, font, 14, 72, 720, "FAKE Blood Test Results (eForm)");
                String[][] rows = {{"Test", "Result"}, {"FAKE Glucose", "5.1 mmol/L"}, {"FAKE Sodium", "140 mmol/L"}};
                float y = 680;
                for (String[] row : rows) {
                    content.addRect(72, y - 6, 400, 22);
                    content.stroke();
                    line(content, font, 11, 80, y, row[0]);
                    line(content, font, 11, 300, y, row[1]);
                    y -= 22;
                }
            }
            document.save(path.toFile());
        }
    }

    static void protect(Path in, Path out, String password, int bits, boolean aes) throws Exception {
        try (PDDocument document = Loader.loadPDF(in.toFile())) {
            StandardProtectionPolicy policy =
                    new StandardProtectionPolicy(password, password, new AccessPermission());
            policy.setEncryptionKeyLength(bits);
            policy.setPreferAES(aes);
            document.protect(policy);
            document.save(out.toFile());
        }
    }
}
