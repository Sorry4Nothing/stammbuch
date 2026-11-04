import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { errorHandler } from "../../lib/errors.js";
import { createCamtModule } from "./index.js";
import { InMemoryCamtRepository } from "./repository.js";
import { CamtRestService } from "./rest.js";
import { CamtImportService } from "./service.js";
import { MAX_CAMT_BYTES } from "./upload.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const R1 = "000000021000000000000100009";

const allow = { authorize: () => Promise.resolve() };
const scopeOf =
  (service: CamtImportService, repo = new InMemoryCamtRepository()) =>
  () => ({
    service,
    rest: new CamtRestService(repo, { assign: () => Promise.resolve("ASSIGNED") }),
  });

async function setup() {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const service = new CamtImportService(new InMemoryCamtRepository(), {
    findByReferences: (refs) =>
      Promise.resolve(
        refs.includes(R1)
          ? [{ id: "inv-1", reference: R1, amountRappen: 12000, currency: "CHF" }]
          : [],
      ),
  });
  await app.register(async (scope) => {
    await createCamtModule({ ...allow, scope: scopeOf(service) }).register(scope);
  });
  return app;
}

/** Baut einen multipart/form-data-Body von Hand; Dateiname und Content-Type sind frei wählbar. */
function multipart(
  parts: { name: string; filename?: string; type?: string; data: Buffer | string }[],
) {
  const boundary = "----testgrenze";
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}`;
    const type = p.type ? `\r\nContent-Type: ${p.type}` : "";
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}${type}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
const file = (data: Buffer | string, extra = {}) =>
  multipart([
    { name: "file", filename: "x.bin", type: "application/octet-stream", data, ...extra },
  ]);

describe("POST /camt/import", () => {
  it("importiert und ordnet zu; Dateiname und Content-Type spielen keine Rolle", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/camt/import",
      ...file(fixture("camt053-v04.xml")),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      kind: "camt.053",
      counts: { total: 5, matched: 1, rest: 3, duplicates: 0, ignored: 2 },
    });
    expect(body.matched[0]).toMatchObject({ openItemId: "inv-1", amountRappen: 12000 });
    expect(body.rest.map((p: { restReason: string }) => p.restReason)).toEqual([
      "NO_OPEN_ITEM",
      "NO_REFERENCE",
      "REVERSAL",
    ]);
    // Antwort enthält keine internen Felder (SR-74).
    expect(body.matched[0]).not.toHaveProperty("bookingKey");
    expect(body.matched[0]).not.toHaveProperty("importId");
    await app.close();
  });

  it("antwortet bei erneutem Upload mit 409 und der Import-ID", async () => {
    const app = await setup();
    const first = await app.inject({
      method: "POST",
      url: "/camt/import",
      ...file(fixture("camt054-v08.xml")),
    });
    const again = await app.inject({
      method: "POST",
      url: "/camt/import",
      ...file(fixture("camt054-v08.xml")),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { code: "DUPLICATE_FILE" },
      importId: first.json().importId,
    });
    await app.close();
  });

  it("lehnt falsche Inhalte mit festen Meldungen ab", async () => {
    const app = await setup();
    const post = (m: ReturnType<typeof multipart>) =>
      app.inject({ method: "POST", url: "/camt/import", ...m });

    const html = await post(file("<html></html>", { filename: "auszug.xml", type: "text/xml" }));
    expect(html.statusCode).toBe(400);
    expect(html.json().error.code).toBe("INVALID_UPLOAD");

    const wrongField = await post(
      multipart([{ name: "datei", filename: "a.xml", data: fixture("camt053-v04.xml") }]),
    );
    expect(wrongField.statusCode).toBe(400);

    const notCamt = await post(file(`<?xml version="1.0"?><Document xmlns="urn:foo"/>`));
    expect(notCamt.statusCode).toBe(422);
    expect(notCamt.json().error.code).toBe("UNSUPPORTED_FORMAT");

    const xxe = await post(
      file(
        `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><Document>&x;</Document>`,
      ),
    );
    expect(xxe.statusCode).toBe(422);
    expect(xxe.body).not.toContain("passwd");
    await app.close();
  });

  it("lehnt zu grosse Dateien ab (413)", async () => {
    const app = await setup();
    const big = Buffer.alloc(MAX_CAMT_BYTES + 1024, "a");
    const res = await app.inject({ method: "POST", url: "/camt/import", ...file(big) });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it("lehnt Nicht-Multipart-Anfragen ab", async () => {
    const app = await setup();
    const json = await app.inject({
      method: "POST",
      url: "/camt/import",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(json.statusCode).toBeGreaterThanOrEqual(400);
    expect(json.statusCode).toBeLessThan(500);
    await app.close();
  });

  it("verrät bei internen Fehlern nichts", async () => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const service = new CamtImportService(new InMemoryCamtRepository(), {
      findByReferences: () => Promise.reject(new Error("db.intern:5432 down")),
    });
    await app.register(async (scope) => {
      await createCamtModule({ ...allow, scope: scopeOf(service) }).register(scope);
    });
    const res = await app.inject({
      method: "POST",
      url: "/camt/import",
      ...file(fixture("camt053-v04.xml")),
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("intern");
    await app.close();
  });
});

describe("Zugriffsschutz (SR-10)", () => {
  it("verweigert in der Standard-Einhängung jeden Import", async () => {
    const app = await buildApp(loadConfig({ LOG_LEVEL: "silent" }));
    const res = await app.inject({
      method: "POST",
      url: "/camt/import",
      ...file(fixture("camt053-v04.xml")),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("ruft die Autorisierung vor dem Lesen der Datei auf", async () => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    let imported = false;
    const service = new CamtImportService(new InMemoryCamtRepository(), {
      findByReferences: () => {
        imported = true;
        return Promise.resolve([]);
      },
    });
    await app.register(async (scope) => {
      await createCamtModule({
        scope: scopeOf(service),
        authorize: (_req, reply) => {
          void reply.status(403).send({ error: { code: "FORBIDDEN", message: "Nein." } });
          return Promise.resolve();
        },
      }).register(scope);
    });
    const res = await app.inject({
      method: "POST",
      url: "/camt/import",
      ...file(fixture("camt053-v04.xml")),
    });
    expect(res.statusCode).toBe(403);
    expect(imported).toBe(false);
    await app.close();
  });
});
