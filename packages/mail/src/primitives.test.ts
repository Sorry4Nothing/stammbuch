import { describe, expect, it } from "vitest";
import { checkAttachment, safeFilename } from "./attachments.js";
import { SecretBox, keyRingFromEnv } from "./crypto.js";
import { assertEmail } from "./headers.js";
import { MailError, resolvePublicHost, SMTP_PORTS } from "./net-guard.js";
import { htmlToText, sanitizeMailHtml } from "./sanitize.js";
import { assertKnownPlaceholders, renderTemplate } from "./template.js";
import { TEST_KEY } from "./test-helpers.js";

const key = (n: number) => Buffer.alloc(32, n).toString("base64");

describe("SecretBox (AES-256-GCM, SR-30)", () => {
  const box = new SecretBox({ keys: { k1: TEST_KEY }, currentKeyId: "k1" });

  it("verschlüsselt und entschlüsselt, Chiffretext enthält keinen Klartext", () => {
    const token = box.encrypt("geheimes-app-passwort", "acc-1");
    expect(token).not.toContain("geheimes");
    expect(box.decrypt(token, "acc-1")).toBe("geheimes-app-passwort");
  });

  it("nutzt pro Verschlüsselung einen neuen IV", () => {
    expect(box.encrypt("x", "a")).not.toBe(box.encrypt("x", "a"));
  });

  it("verweigert einen anderen Kontext, manipulierte Daten und fremde Schlüssel", () => {
    const token = box.encrypt("x", "acc-1");
    expect(() => box.decrypt(token, "acc-2")).toThrow("Entschlüsselung fehlgeschlagen");
    const parts = token.split(".");
    parts[4] = Buffer.from("manipuliert").toString("base64url");
    expect(() => box.decrypt(parts.join("."), "acc-1")).toThrow();
    const other = new SecretBox({ keys: { k1: key(9) }, currentKeyId: "k1" });
    expect(() => other.decrypt(token, "acc-1")).toThrow();
    expect(() => box.decrypt("müll", "acc-1")).toThrow();
  });

  it("Fehlertexte verraten weder Klartext noch Schlüssel", () => {
    const token = box.encrypt("topsecret", "a");
    try {
      box.decrypt(token, "b");
    } catch (e) {
      expect(String(e)).not.toContain("topsecret");
      expect(String(e)).not.toContain(TEST_KEY);
    }
  });

  it("Schlüsselrotation: alte Daten bleiben lesbar, neu wird mit dem aktuellen Schlüssel geschrieben", () => {
    const old = box.encrypt("pw", "a");
    const rotated = new SecretBox({ keys: { k1: TEST_KEY, k2: key(3) }, currentKeyId: "k2" });
    expect(rotated.decrypt(old, "a")).toBe("pw");
    expect(rotated.needsRotation(old)).toBe(true);
    const fresh = rotated.rotate(old, "a");
    expect(rotated.needsRotation(fresh)).toBe(false);
    expect(fresh.split(".")[1]).toBe("k2");
    expect(rotated.decrypt(fresh, "a")).toBe("pw");
  });

  it("lehnt Schlüssel falscher Länge und fehlenden aktuellen Schlüssel ab", () => {
    expect(() => new SecretBox({ keys: { k1: "AAAA" }, currentKeyId: "k1" })).toThrow();
    expect(() => new SecretBox({ keys: { k1: TEST_KEY }, currentKeyId: "k9" })).toThrow();
  });

  it("liest den Schlüsselring aus der Umgebung", () => {
    const ring = keyRingFromEnv(`k1:${key(1)}, k2:${key(2)}`, "k2");
    expect(Object.keys(ring.keys)).toEqual(["k1", "k2"]);
    expect(() => keyRingFromEnv("ohne-doppelpunkt", "k1")).toThrow();
  });
});

describe("SSRF-Schutz für Mail-Server (SR-26)", () => {
  const resolverTo =
    (...ips: string[]) =>
    async () =>
      ips;
  const code = async (p: Promise<unknown>) => (await p.catch((e: MailError) => e)) as MailError;

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])("verweigert %s", async (ip) => {
    expect((await code(resolvePublicHost(ip, 587, SMTP_PORTS))).code).toBe("BLOCKED_HOST");
    expect(
      (
        await code(
          resolvePublicHost("x.example.test", 587, SMTP_PORTS, { resolver: resolverTo(ip) }),
        )
      ).code,
    ).toBe("BLOCKED_HOST");
  });

  it("verweigert, wenn nur eine von mehreren Adressen intern ist (DNS-Rebinding)", async () => {
    const r = resolverTo("93.184.216.34", "10.0.0.1");
    expect(
      (await code(resolvePublicHost("mail.example.test", 587, SMTP_PORTS, { resolver: r }))).code,
    ).toBe("BLOCKED_HOST");
  });

  it("verweigert Ports ausserhalb der Allowlist (kein Portscan über den Server)", async () => {
    const r = { resolver: resolverTo("93.184.216.34") };
    expect((await code(resolvePublicHost("mail.example.test", 22, SMTP_PORTS, r))).code).toBe(
      "BAD_PORT",
    );
    expect((await code(resolvePublicHost("mail.example.test", 6379, SMTP_PORTS, r))).code).toBe(
      "BAD_PORT",
    );
  });

  it("verweigert Hostnamen mit Sonderzeichen", async () => {
    for (const h of ["a@b.test", "a.test/x", "a b.test", "a.test:25", "-a.test", "a..test"]) {
      expect(
        (
          await code(
            resolvePublicHost(h, 587, SMTP_PORTS, { resolver: resolverTo("93.184.216.34") }),
          )
        ).code,
      ).toBe("BLOCKED_HOST");
    }
  });

  it("gibt die geprüfte öffentliche IP zurück (Verbindung geht auf diese IP)", async () => {
    const ip = await resolvePublicHost("mail.example.test", 587, SMTP_PORTS, {
      resolver: resolverTo("93.184.216.34"),
    });
    expect(ip).toBe("93.184.216.34");
  });

  it("allowPrivateHosts erlaubt nur im Entwicklungsmodus interne Ziele", async () => {
    expect(
      await resolvePublicHost("127.0.0.1", 2525, SMTP_PORTS, { allowPrivateHosts: true }),
    ).toBe("127.0.0.1");
    expect((await code(resolvePublicHost("127.0.0.1", 2525, SMTP_PORTS))).code).toBe(
      "BLOCKED_HOST",
    );
  });
});

describe("Platzhalter (kein Template-Injection)", () => {
  it("maskiert HTML in Werten und setzt in einem Durchgang ein", () => {
    const html = renderTemplate(
      "<p>{{name}}</p>",
      { name: '<img src=x onerror="alert(1)">{{email}}', email: "geheim@example.test" },
      "html",
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    // Der eingesetzte Wert wird nicht erneut als Platzhalter gelesen.
    expect(html).toContain("{{email}}");
    expect(html).not.toContain("geheim@");
  });

  it("entfernt Zeilenumbrüche in Header-Werten", () => {
    expect(renderTemplate("Hi {{name}}", { name: "A\r\nBcc: x@y.z" }, "header")).toBe(
      "Hi A Bcc: x@y.z",
    );
  });

  it("greift nicht auf Prototypen zu und lässt Unbekanntes leer", () => {
    expect(renderTemplate("{{constructor}}|{{__proto__}}|{{toString}}|{{fehlt}}", {}, "text")).toBe(
      "|{{__proto__}}||",
    );
  });

  it("lehnt unbekannte Platzhalter in der Vorlage ab", () => {
    expect(() => assertKnownPlaceholders("{{name}} {{process}}", ["name"])).toThrow(MailError);
    expect(() => assertKnownPlaceholders("{{name}} {{ NAME }}", ["name"])).not.toThrow();
  });
});

describe("HTML-Bereinigung (SR-20)", () => {
  it("entfernt Skripte, Event-Handler, iframes, Formulare und javascript:-Links", () => {
    const dirty =
      '<p onclick="x()">Hallo</p><script>alert(1)</script><iframe src="https://e.test"></iframe>' +
      '<form action="https://e.test"><input></form><a href="javascript:alert(1)">klick</a>' +
      '<a href="data:text/html;base64,AAAA">d</a><style>body{display:none}</style>' +
      '<svg onload="x()"><circle/></svg><a href="https://ok.example.test/">ok</a>';
    const clean = sanitizeMailHtml(dirty);
    for (const bad of [
      "script",
      "onclick",
      "iframe",
      "<form",
      "<input",
      "javascript:",
      "data:text",
      "<style",
      "svg",
      "onload",
    ]) {
      expect(clean).not.toContain(bad);
    }
    expect(clean).toContain('href="https://ok.example.test/"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
  });

  it("blockiert Remote-Bilder beim Lesen (Tracking), erlaubt cid: und Raster-data:", () => {
    const html =
      '<img src="https://tracker.example.test/p.gif"><img src="cid:logo@x"><img src="data:image/png;base64,iVBORw0KGgo=">' +
      '<img src="data:image/svg+xml;base64,PHN2Zz4="><img src="//tracker.example.test/x.gif">';
    const read = sanitizeMailHtml(html);
    expect(read).not.toContain("tracker");
    expect(read).toContain("cid:logo@x");
    expect(read).toContain("data:image/png");
    expect(read).not.toContain("svg+xml");
    expect(sanitizeMailHtml(html, { allowRemoteImages: true })).toContain(
      "https://tracker.example.test/p.gif",
    );
  });

  it("lässt nur erlaubte Styles zu", () => {
    const clean = sanitizeMailHtml(
      '<p style="color:#111;position:fixed;background:url(javascript:x)">x</p>',
    );
    expect(clean).toContain("color:#111");
    expect(clean).not.toContain("position");
    expect(clean).not.toContain("url(");
  });

  it("erzeugt eine Textfassung", () => {
    expect(htmlToText("<p>A &amp; B</p><p>C<br>D</p>")).toBe("A & B\nC\nD");
  });
});

describe("Header- und Anhangsprüfung", () => {
  it("lehnt Adressen mit Injection-Mustern ab", () => {
    for (const bad of [
      "a@b.ch\r\nBcc: x@y.ch",
      "a@b.ch,c@d.ch",
      '"a b"@c.ch',
      "a@b.ch>",
      "a b@c.ch",
      "a@b",
      "<a@b.ch>",
      "a@b.ch;c@d.ch",
    ]) {
      expect(() => assertEmail(bad), bad).toThrow(MailError);
    }
    expect(assertEmail("Anna.Muster+x@Example.CH")).toBe("anna.muster+x@example.ch");
  });

  it("bereinigt Dateinamen und prüft Endung, Grösse und Inhalt", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("a\r\nb.pdf")).toBe("a__b.pdf");
    const pdf = Buffer.from("%PDF-1.4 inhalt");
    expect(checkAttachment("x.PDF", pdf, 100)).toMatchObject({
      contentType: "application/pdf",
      size: pdf.length,
    });
    expect(() => checkAttachment("x.exe", pdf, 100)).toThrow(MailError);
    expect(() => checkAttachment("x.html", pdf, 100)).toThrow(MailError);
    expect(() => checkAttachment("x.pdf", Buffer.from("MZ nicht pdf"), 100)).toThrow(MailError);
    expect(() => checkAttachment("x.pdf", pdf, 5)).toThrow(MailError);
    expect(() => checkAttachment("x.pdf", Buffer.alloc(0), 5)).toThrow(MailError);
    expect(() => checkAttachment("kein-ende", pdf, 100)).toThrow(MailError);
  });
});
