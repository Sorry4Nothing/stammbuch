import { buildOutgoing } from "./message.js";
import type { SecretBox } from "./crypto.js";
import { MailError, type MailErrorCode } from "./net-guard.js";
import type { ConnectionFactory, SmtpConnection } from "./ports.js";
import type { MailRepositories } from "./repositories.js";
import { classifyError, isPermanent } from "./transport.js";
import type { Delivery } from "./types.js";

export interface ProcessorConfig {
  /** Fällige Zustellungen pro Durchlauf. */
  batchSize: number;
  /** Obergrenze pro Kunde (Mandant) und Minute (Rate-Limit gegen Sperrung des Absenders). */
  perTenantPerMinute: number;
  maxAttempts: number;
  /** Nach dieser Zeit gilt eine „sending“-Zustellung als verwaist (Worker-Absturz) und wird neu aufgenommen. */
  leaseMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const defaultProcessorConfig: ProcessorConfig = {
  batchSize: 50,
  perTenantPerMinute: 60,
  maxAttempts: 6,
  leaseMs: 120_000,
  baseBackoffMs: 60_000,
  maxBackoffMs: 6 * 3_600_000,
};

export interface ProcessorDeps {
  repos: MailRepositories;
  box: SecretBox;
  connections: ConnectionFactory;
  config?: Partial<ProcessorConfig>;
  now?: () => Date;
  random?: () => number;
}

export interface ProcessResult {
  sent: number;
  retried: number;
  failed: number;
  /** Fällig, aber wegen des Kunden-Limits auf den nächsten Durchlauf verschoben. */
  deferred: number;
}

/** Exponentielles Backoff mit ±20 % Streuung. `attempts` zählt den gerade gescheiterten Versuch. */
export function backoffMs(attempts: number, cfg: ProcessorConfig, random: () => number): number {
  const base = Math.min(cfg.baseBackoffMs * 2 ** Math.max(0, attempts - 1), cfg.maxBackoffMs);
  return Math.round(base * (0.8 + 0.4 * random()));
}

/**
 * Ein Durchlauf der Versandqueue (Worker). Mindestens-einmal-Zustellung: Stürzt der Worker
 * zwischen Senden und Speichern ab, geht die Mail nach Ablauf der Sperre erneut raus.
 * Fehler werden nur als fester Code gespeichert, nie als Rohtext des Servers.
 */
export async function processDueDeliveries(
  deps: ProcessorDeps,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const cfg = { ...defaultProcessorConfig, ...deps.config };
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const { repos } = deps;
  const result: ProcessResult = { sent: 0, retried: 0, failed: 0, deferred: 0 };

  const t0 = now();
  const budgets = new Map<string, number>();
  const connections = new Map<string, SmtpConnection | MailError>();

  try {
    for (const due of await repos.campaigns.listDue(t0, cfg.batchSize)) {
      if (signal?.aborted) break;

      let budget = budgets.get(due.tenantId);
      if (budget === undefined) {
        const sentRecently = await repos.campaigns.countSentSince(
          due.tenantId,
          new Date(t0.getTime() - 60_000),
        );
        budget = Math.max(0, cfg.perTenantPerMinute - sentRecently);
      }
      if (budget <= 0) {
        budgets.set(due.tenantId, 0);
        result.deferred++;
        continue;
      }
      budgets.set(due.tenantId, budget - 1);

      const claimed = await repos.campaigns.claim(due.id, t0, new Date(t0.getTime() + cfg.leaseMs));
      if (!claimed) continue; // anderer Worker war schneller oder Kampagne wurde abgebrochen

      const outcome = await deliver(claimed);
      if (outcome === "sent") result.sent++;
      else if (outcome === "retry") result.retried++;
      else result.failed++;
    }
  } finally {
    for (const c of connections.values()) if (!(c instanceof MailError)) c.close();
  }
  return result;

  async function deliver(d: Delivery): Promise<"sent" | "retry" | "failed"> {
    try {
      const campaign = await repos.campaigns.getById(d.campaignId);
      if (!campaign || campaign.state !== "confirmed") return await fail(d, "NOT_FOUND", true);
      const account = await repos.accounts.get(campaign.tenantId, campaign.accountId);
      if (!account) return await fail(d, "NOT_FOUND", true);

      const attachments = [];
      for (const id of campaign.attachmentIds) {
        const a = await repos.attachments.get(campaign.tenantId, id);
        if (!a) return await fail(d, "NOT_FOUND", true);
        attachments.push({
          filename: a.meta.filename,
          contentType: a.meta.contentType,
          content: a.bytes,
        });
      }

      let conn = connections.get(account.id);
      if (!conn) {
        try {
          const password = deps.box.decrypt(account.secretEnc, account.id);
          conn = await deps.connections.smtp(account, password);
        } catch (err) {
          conn = classifyError(err);
        }
        connections.set(account.id, conn);
      }
      // Ein Verbindungsfehler gilt für alle weiteren Zustellungen dieses Kontos im Durchlauf.
      if (conn instanceof MailError) return await fail(d, conn.code, isPermanent(conn.code));

      const mail = buildOutgoing(account, campaign, d.recipient, attachments);
      const sent = await conn.send(mail);
      await repos.campaigns.finish(d.id, {
        status: "sent",
        sentAt: now(),
        messageId: sent.messageId,
      });
      return "sent";
    } catch (err) {
      const code = classifyError(err).code;
      return await fail(d, code, isPermanent(code));
    }
  }

  async function fail(d: Delivery, code: MailErrorCode, permanent: boolean) {
    if (permanent || d.attempts >= cfg.maxAttempts) {
      await repos.campaigns.finish(d.id, { status: "failed", lastError: code });
      return "failed" as const;
    }
    await repos.campaigns.finish(d.id, {
      status: "queued",
      lastError: code,
      nextAttemptAt: new Date(now().getTime() + backoffMs(d.attempts, cfg, random)),
    });
    return "retry" as const;
  }
}
