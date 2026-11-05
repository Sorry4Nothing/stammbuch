import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretBox, totpBoxFromEnv } from "./crypto.js";
import { rotateAll } from "./rotation.js";
import type { RotationRow, RotationSource } from "./rotation.js";

const k = (n: number) => Buffer.alloc(32, n);
const env = { AUTH_TOTP_KEY: k(1).toString("base64") };
const ring = totpBoxFromEnv({
  ...env,
  AUTH_TOTP_KEYS: `k1:${k(5).toString("base64")},k2:${k(6).toString("base64")}`,
});
const k1Box = totpBoxFromEnv({ ...env, AUTH_TOTP_KEYS: `k1:${k(5).toString("base64")}` });
const stranger = new SecretBox({ keys: { x: k(9).toString("base64") }, currentKeyId: "x" });

/** Altformat vor dem Schlüsselring: `v1.<iv>.<tag>.<ct>` mit dem Hauptschlüssel. */
function legacy(aad: string, plain: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k(1), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct]
    .map((p) => (Buffer.isBuffer(p) ? p.toString("base64url") : p))
    .join(".");
}

/** Wie die Datenbank: nach ID sortiert, nur was nicht dem aktuellen Schlüssel entspricht, Compare-and-swap. */
function memorySource(rows: Map<string, RotationRow>, onReplace?: () => void): RotationSource {
  return {
    list: async (keyId, after, limit) =>
      [...rows.values()]
        .filter((r) => {
          const p = r.enc.split(".");
          return (p.length !== 5 || p[1] !== keyId) && (after === null || r.id > after);
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    replace: async (tenantId, id, expected, enc) => {
      const r = rows.get(id);
      if (r?.tenantId !== tenantId || r.enc !== expected) return false;
      rows.set(id, { ...r, enc });
      onReplace?.();
      return true;
    },
  };
}

function seed(n: number, enc: (id: string, i: number) => string) {
  const rows = new Map<string, RotationRow>();
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    rows.set(id, { id, tenantId: i % 3 ? "tenant-a" : "tenant-b", enc: enc(id, i) });
  }
  return rows;
}

describe("Rotationslauf (TOTP-Geheimnisse über alle Mandanten)", () => {
  it("schlüsselt Altformat und alten Schlüssel um, einmalig, über mehrere Seiten", async () => {
    const rows = seed(250, (id, i) =>
      i % 2 ? legacy(id, Buffer.alloc(20, 3)) : k1Box.encryptBytes(Buffer.alloc(20, 3), id),
    );
    expect(await rotateAll(ring, memorySource(rows))).toEqual({
      rotated: 250,
      failed: [],
      aborted: false,
    });
    for (const r of rows.values()) {
      expect(r.enc.split(".")[1]).toBe("k2");
      expect(ring.decryptBytes(r.enc, r.id).equals(Buffer.alloc(20, 3))).toBe(true);
    }
    expect((await rotateAll(ring, memorySource(rows))).rotated).toBe(0);
  });

  it("Abbruch mitten im Lauf: nichts geht verloren, der nächste Lauf setzt fort", async () => {
    const rows = seed(5, (id, i) => legacy(id, Buffer.alloc(20, i + 1)));
    const controller = new AbortController();
    const partial = await rotateAll(
      ring,
      memorySource(rows, () => controller.abort()),
      controller.signal,
    );
    expect(partial).toEqual({ rotated: 1, failed: [], aborted: true });
    expect([...rows.values()].filter((r) => r.enc.split(".")[1] === "k2")).toHaveLength(1);
    expect((await rotateAll(ring, memorySource(rows))).rotated).toBe(4);
    for (const r of rows.values()) expect(ring.decryptBytes(r.enc, r.id)).toHaveLength(20);
  });

  it("ein unlesbares Geheimnis steht nur als ID im Ergebnis und hält die anderen nicht auf", async () => {
    const rows = seed(3, (id, i) =>
      i === 1 ? stranger.encryptBytes(Buffer.alloc(20, 2), id) : legacy(id, Buffer.alloc(20, 2)),
    );
    const lost = [...rows.values()][1]!;
    const result = await rotateAll(ring, memorySource(rows));
    expect(result).toEqual({ rotated: 2, failed: [lost.id], aborted: false });
    expect(rows.get(lost.id)).toEqual(lost);
    // Der nächste Lauf meldet es wieder, ohne etwas zu verändern.
    expect((await rotateAll(ring, memorySource(rows))).failed).toEqual([lost.id]);
  });

  it("überschreibt keine gleichzeitige Änderung (Compare-and-swap)", async () => {
    const rows = seed(1, (id) => legacy(id, Buffer.alloc(20, 1)));
    const [row] = [...rows.values()];
    const src = memorySource(rows);
    const racing: RotationSource = {
      list: src.list,
      replace: async (...args) => {
        rows.set(row!.id, { ...row!, enc: ring.encryptBytes(Buffer.alloc(20, 8), row!.id) });
        return src.replace(...args);
      },
    };
    expect((await rotateAll(ring, racing)).rotated).toBe(0);
    expect(ring.decryptBytes(rows.get(row!.id)!.enc, row!.id)[0]).toBe(8);
  });

  it("ein Datenbankfehler bricht den Lauf ab, ohne etwas zu verlieren", async () => {
    const rows = seed(3, (id) => legacy(id, Buffer.alloc(20, 1)));
    const src = memorySource(rows);
    let calls = 0;
    const failing: RotationSource = {
      list: src.list,
      replace: async (...args) => {
        if (++calls === 2) throw new Error("Verbindung weg");
        return src.replace(...args);
      },
    };
    await expect(rotateAll(ring, failing)).rejects.toThrow("Verbindung weg");
    expect((await rotateAll(ring, memorySource(rows))).rotated).toBe(2);
  });
});
