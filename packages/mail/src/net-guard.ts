import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Fehler mit festem Code; der Text geht nie an den Client (SR-51). */
export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export type MailErrorCode =
  | "BLOCKED_HOST"
  | "BAD_PORT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION"
  | "CONFLICT"
  | "CONNECT"
  | "TLS"
  | "AUTH"
  | "REJECTED"
  | "TRANSIENT"
  | "TOO_LARGE"
  | "INTERNAL";

/** Nicht öffentlich routbare Bereiche (SR-26): Loopback, privat, Link-Local/Metadaten, CGNAT, Multicast, ULA. */
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) wie die enthaltene IPv4-Adresse behandeln.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);
  if (/^::ffff:/i.test(ip)) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export const SMTP_PORTS = [465, 587, 2525] as const;
export const IMAP_PORTS = [993, 143] as const;

export interface HostGuardOptions {
  /** Nur Entwicklung/Tests: interne Adressen und beliebige Ports erlauben. */
  allowPrivateHosts?: boolean;
  resolver?: Resolver;
}

/**
 * SSRF-Schutz für nutzerdefinierte Mail-Server (SR-26): löst den Host auf und verweigert
 * alles, was nicht ausschliesslich auf öffentliche Adressen zeigt. Gibt die geprüfte IP
 * zurück; die Verbindung geht auf diese IP (mit `servername` für TLS), damit zwischen
 * Prüfung und Verbindung kein DNS-Rebinding möglich ist. Port nur aus der Allowlist.
 */
export async function resolvePublicHost(
  host: string,
  port: number,
  allowedPorts: readonly number[],
  opts: HostGuardOptions = {},
): Promise<string> {
  const allowPrivate = opts.allowPrivateHosts === true;
  if (!allowPrivate && !allowedPorts.includes(port)) throw new MailError("BAD_PORT");
  if (!isIP(host) && (host.length > 253 || !HOSTNAME.test(host)))
    throw new MailError("BLOCKED_HOST");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (opts.resolver ?? systemResolver)(host);
    } catch {
      throw new MailError("CONNECT");
    }
  }
  const first = addresses[0];
  if (!first) throw new MailError("CONNECT");
  // Alle Adressen müssen öffentlich sein, sonst könnte ein Eintrag intern zeigen.
  if (!allowPrivate && addresses.some(isBlockedAddress)) throw new MailError("BLOCKED_HOST");
  return first;
}
