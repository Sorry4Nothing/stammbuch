import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RESERVED_SLUGS, slugCandidate, slugFromName } from "@stammbuch/shared";
import type { Role } from "@stammbuch/shared";
import type {
  AuditRepository,
  NewTenant,
  Platform,
  Principal,
  Tenant,
  TenantRepository,
} from "./types.js";

/** Der Slug ist schon vergeben (UNIQUE auf `kunde.slug`). */
export class SlugTakenError extends Error {
  constructor() {
    super("Slug schon vergeben");
  }
}

const SLUG_TRIES = 100;

/**
 * Legt den Kunden an. Ohne `wanted` kommt der Slug aus dem Namen; bei Kollision folgen `-2`, `-3`, …
 * Die Kollision meldet das Repository über den UNIQUE-Constraint (keine Rennbedingung zwischen Prüfen und Anlegen).
 * Mit `wanted` (Überschreiben durch den Chef-Admin) gibt es keinen zweiten Versuch: `SlugTakenError`.
 */
export async function createTenant(
  tenants: TenantRepository,
  actorId: string,
  tenant: Omit<NewTenant, "slug">,
  wanted?: string,
): Promise<NewTenant> {
  if (wanted) {
    const t = { ...tenant, slug: wanted };
    await tenants.create(actorId, t);
    return t;
  }
  const base = slugFromName(tenant.name);
  for (let n = 1; n <= SLUG_TRIES; n++) {
    const slug = slugCandidate(base, n);
    if (RESERVED_SLUGS.includes(slug)) continue;
    try {
      const t = { ...tenant, slug };
      await tenants.create(actorId, t);
      return t;
    } catch (err) {
      if (!(err instanceof SlugTakenError)) throw err;
    }
  }
  throw new SlugTakenError();
}

export const INVITATION_DAYS = 7;

/** Einladungs-Tokens werden nur gehasht gespeichert. 256 Bit Zufall, daher reicht SHA-256. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Legt eine Einladung an und übergibt das Token ausschliesslich an den Versand (nie an die Antwort). */
export async function invite(
  platform: Pick<Platform, "invitations" | "invitationSender" | "clock">,
  tenant: Pick<Tenant, "id" | "name">,
  to: { email: string; role: Role; userId: string | null; name?: string | undefined },
) {
  const now = platform.clock();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 86_400_000).toISOString();
  await platform.invitations.create({
    id: randomUUID(),
    tenantId: tenant.id,
    email: to.email,
    role: to.role,
    userId: to.userId,
    name: to.name ?? null,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt,
    consumedAt: null,
  });
  await platform.invitationSender.send({ to: to.email, token, tenantName: tenant.name, expiresAt });
}

/** Schreibt einen Protokolleintrag. Enthält nie Feldwerte, nur was geschah und woran (SR-50, SR-41). */
export async function record(
  repo: AuditRepository,
  clock: () => Date,
  scope: string,
  actor: Principal,
  action: string,
  target = "",
) {
  await repo.append(scope, {
    id: randomUUID(),
    at: clock().toISOString(),
    actorId: actor.kind === "chef" ? actor.accountId : actor.userId,
    actor: actor.email,
    action,
    target,
  });
}
