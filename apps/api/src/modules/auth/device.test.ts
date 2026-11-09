import { describe, expect, it } from "vitest";
import { base32Decode } from "./base32.js";
import { setup, PASSWORD } from "./auth.testkit.js";
import { deviceLabel } from "./device.js";

const FIREFOX_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

describe("deviceLabel", () => {
  it("nennt Browser und System aus fester Liste", () => {
    expect(deviceLabel(FIREFOX_WIN)).toBe("Firefox auf Windows");
    expect(deviceLabel(EDGE_WIN)).toBe("Edge auf Windows");
    expect(deviceLabel(SAFARI_IPHONE)).toBe("Safari auf iOS");
    expect(deviceLabel(CHROME_ANDROID)).toBe("Chrome auf Android");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/17 Safari/605",
      ),
    ).toBe("Safari auf macOS");
    expect(
      deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"),
    ).toBe("Firefox auf Linux");
  });

  it("gibt bei Unbekanntem oder Fehlendem null zurück und nie den rohen Text", () => {
    expect(deviceLabel(undefined)).toBeNull();
    expect(deviceLabel("")).toBeNull();
    expect(deviceLabel("curl/8.5.0")).toBeNull();
    expect(deviceLabel("<script>alert(1)</script> geheim@beispiel.test")).toBeNull();
    expect(deviceLabel(`${"A".repeat(5000)} Firefox/1`)).toBeNull(); // hinter der Grenze von 512 Zeichen
    expect(deviceLabel("Windows ".repeat(20))).toBe("Windows");
  });
});

describe("Gerät der Sitzung", () => {
  const EMAIL = "geraet@verein.test";

  it("steht an der Sitzung, bleibt über Rotation und Passwortwechsel und wird in /auth/security gezeigt", async () => {
    const t = await setup();
    await t.addUser(EMAIL);
    const ua = { "user-agent": FIREFOX_WIN };
    const login = await t.req(
      "POST",
      "/auth/login",
      undefined,
      { email: EMAIL, password: PASSWORD },
      ua,
    );
    expect(login.statusCode).toBe(200);
    const pending = { cookie: t.cookieOf(login)!.value, csrf: login.json().csrfToken as string };
    const setupRes = await t.req("POST", "/auth/2fa/setup", pending);
    const secret = base32Decode(setupRes.json().secret);
    // Der zweite Faktor kommt ohne User-Agent: das Gerät stammt aus der Anmeldung.
    const done = await t.req("POST", "/auth/2fa", pending, { code: t.codeAt(secret) });
    expect(done.statusCode).toBe(200);
    const full = { cookie: t.cookieOf(done)!.value, csrf: done.json().csrfToken as string };

    const info = await t.req("GET", "/auth/security", full);
    expect(info.json().device).toBe("Firefox auf Windows");

    const changed = await t.req("POST", "/auth/password", full, {
      currentPassword: PASSWORD,
      newPassword: "ein-ganz-anderes-passwort-9",
    });
    expect(changed.statusCode).toBe(200);
    const after = { cookie: t.cookieOf(changed)!.value, csrf: changed.json().csrfToken as string };
    expect((await t.req("GET", "/auth/security", after)).json().device).toBe("Firefox auf Windows");

    // Gespeichert ist nur die Kurzform, nie der rohe User-Agent.
    expect(JSON.stringify([...t.sessions.sessions.values()])).not.toContain("Mozilla");
    expect(JSON.stringify(await t.audit.list({}))).not.toContain("Mozilla");
    await t.app.close();
  });

  it("ohne erkennbaren User-Agent bleibt das Gerät leer", async () => {
    const t = await setup();
    await t.addUser(EMAIL);
    const e = await t.enroll(EMAIL);
    expect((await t.req("GET", "/auth/security", e.c)).json().device).toBeNull();
    await t.app.close();
  });
});
