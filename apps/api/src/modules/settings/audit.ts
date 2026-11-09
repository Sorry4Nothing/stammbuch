import type { FastifyInstance } from "fastify";
import {
  auditEntryResponseSchema,
  auditExportQuerySchema,
  auditQuerySchema,
} from "@stammbuch/shared";
import { toCsv } from "../../lib/csv.js";
import { toXlsx } from "../../lib/xlsx.js";
import { respond, validate } from "../../lib/validate.js";
import { customerOf, record } from "../../platform/index.js";
import { resolveTargets } from "./audit-targets.js";
import type { AuditEntry } from "../../platform/index.js";

const EXPORT_MAX_ROWS = 10_000;

const toDto = (e: AuditEntry) =>
  respond(auditEntryResponseSchema, {
    id: e.id,
    at: e.at,
    actor: e.actor,
    action: e.action,
    target: e.target,
    result: e.result ?? "success",
  });

export function registerAudit(app: FastifyInstance) {
  app.get("/settings/audit", { config: { access: "customer-admin" } }, async (request) => {
    const { tenantId } = await customerOf(request);
    const { limit, offset, ...filter } = validate(auditQuerySchema, request.query);
    const page = await app.platform.audit.query(tenantId, filter, { limit, offset });
    const items = await resolveTargets(app.db, tenantId, page.items);
    return { items: items.map(toDto), total: page.total };
  });

  app.get(
    "/settings/audit/export",
    { config: { access: "customer-admin", rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const principal = await customerOf(request);
      const { platform } = app;
      const { format, ...filter } = validate(auditExportQuerySchema, request.query);
      const page = await platform.audit.query(principal.tenantId, filter, {
        limit: EXPORT_MAX_ROWS,
        offset: 0,
      });
      // Der Export selbst steht im Protokoll.
      await record(platform.audit, platform.clock, principal.tenantId, principal, "audit.export");
      const items = await resolveTargets(app.db, principal.tenantId, page.items);
      const rows = [
        ["Zeitpunkt", "Benutzer", "Aktion", "Objekt", "Ergebnis"],
        ...items.map((e) => [
          e.at,
          e.actor,
          e.action,
          e.target,
          e.result === "failure" ? "Fehlgeschlagen" : "Erfolgreich",
        ]),
      ];
      const xlsx = format === "xlsx";
      return reply
        .header(
          "content-type",
          xlsx
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "text/csv; charset=utf-8",
        )
        .header(
          "content-disposition",
          `attachment; filename="protokoll-${platform.clock().toISOString().slice(0, 10)}.${format}"`,
        )
        .header("x-export-truncated", String(page.total > page.items.length))
        .send(xlsx ? toXlsx(rows) : toCsv(rows));
    },
  );
}
