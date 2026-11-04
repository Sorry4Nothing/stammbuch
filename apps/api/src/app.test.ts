import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { validate } from "./lib/validate.js";
import { loggerOptions } from "./logger.js";

// Der Pool verbindet nie, solange kein Test die Datenbank abfragt.
const DATABASE_URL = "postgres://stammbuch_app:x@127.0.0.1:1/stammbuch";
const config = loadConfig({ LOG_LEVEL: "silent", DATABASE_URL });

describe("GET /health", () => {
  it("antwortet 200 mit Sicherheits-Headern", async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    await app.close();
  });
});

describe("Fehlerbehandlung (SR-51)", () => {
  it("gibt bei unbekannter Route eine generische 404-Antwort", async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/gibt-es-nicht" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("verrät bei ungültiger Eingabe keine Schema-Details", async () => {
    const app = await buildApp(config);
    app.get("/muster", (req) => validate(z.object({ n: z.coerce.number().int() }), req.query));
    const res = await app.inject({ method: "GET", url: "/muster?n=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "VALIDATION", message: "Ungültige Anfrage." } });
    await app.close();
  });

  it("gibt bei unerwarteten Fehlern keine Interna aus", async () => {
    const app = await buildApp(config);
    app.get("/kaputt", () => {
      throw new Error("Verbindung zu db.intern:5432 fehlgeschlagen");
    });
    const res = await app.inject({ method: "GET", url: "/kaputt" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("intern");
    expect(res.json().error.code).toBe("INTERNAL");
    await app.close();
  });
});

describe("Rate-Limit (SR-71)", () => {
  it("antwortet nach Überschreiten mit 429", async () => {
    const app = await buildApp(
      loadConfig({ LOG_LEVEL: "silent", RATE_LIMIT_MAX: "2", DATABASE_URL }),
    );
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await app.inject({ method: "GET", url: "/health" })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });
});

describe("Logging (SR-50)", () => {
  it("schwärzt Authorization, Cookie und Passwörter", () => {
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    pino(loggerOptions("info"), sink).info({
      req: { headers: { authorization: "Bearer geheim", cookie: "sid=geheim" } },
      body: { password: "geheim" },
      password: "geheim",
    });
    expect(out).not.toContain("geheim");
    expect(out).toContain("[REDACTED]");
  });
});

describe("Konfiguration (SR-54)", () => {
  it("startet nicht ohne gültige DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ DATABASE_URL: "" })).toThrow();
    expect(() => loadConfig({ DATABASE_URL: "http://localhost/db" })).toThrow();
    expect(loadConfig({ DATABASE_URL }).DATABASE_URL).toBe(DATABASE_URL);
  });
});
