import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Role } from "@stammbuch/shared";
import type { AuditRepository, Platform, Principal, Tenant } from "./types.js";

export const INVITATION_DAYS = 7;

/** Einladungs-Tokens werden nur gehasht gespeichert. 256 Bit Zufall, daher reicht SHA-256. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Legt eine Einladung an und übergibt das Token ausschliesslich an den Versand (nie an die Antwort). */
export async function invite(
  platform: Pick<Platform, "invitations" | "invitationSender" | "clock">,
  tenant: Pick<Tenant, "id" | "name">,
  to: { email: string; role: Role; userId: string | null },
) {
  const now = platform.clock();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITATION_DAYS * 86_400_000).toISOString();
  await platform.invitations.create({
    id: randomUUID(),
    tenantId: tenant.id,
    ...to,
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
