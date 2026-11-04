import { createMailRuntime, MailService, noGroups } from "@stammbuch/mail";
import type { GroupLookup, MailContext } from "@stammbuch/mail";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { errorHandler } from "../../lib/errors.js";
import { registerMailRoutes, type ContextResolver } from "./routes.js";

export const name = "mail";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Wird von der Authentifizierung (#4) gesetzt: liefert Mandant, Nutzer und Mailadresse
     * der Sitzung oder `null`. Ohne Dekorierung lehnt das Mail-Modul jede Anfrage ab (fail secure).
     */
    resolveMailContext?: ContextResolver;
    /** Gruppenquelle (#3). Ohne sie liefern Gruppen keine Empfänger. */
    mailGroupLookup?: GroupLookup;
  }
}

const deny = async (): Promise<MailContext | null> => null;

export async function register(app: FastifyInstance) {
  const runtime = createMailRuntime();
  if (!runtime) {
    app.log.warn("Mail-Modul aus: MAIL_ENCRYPTION_KEYS ist nicht gesetzt");
    return;
  }
  const service = new MailService({
    repos: runtime.repos,
    box: runtime.box,
    connections: runtime.connections,
    // Lazy: die Gruppenquelle (#3) darf nach diesem Modul registriert werden.
    groups: { membersOf: (ctx, ids) => (app.mailGroupLookup ?? noGroups).membersOf(ctx, ids) },
    config: runtime.service,
  });
  await registerMailRoutes(app, {
    service,
    resolveContext: (req: FastifyRequest) => (app.resolveMailContext ?? deny)(req),
    onError: errorHandler,
  });
}

export { registerMailRoutes } from "./routes.js";
export type { ContextResolver, MailRouteDeps } from "./routes.js";
export type { MailPort } from "@stammbuch/mail";
