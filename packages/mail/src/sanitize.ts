import sanitizeHtml from "sanitize-html";

const TAGS = [
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "hr", "i", "img",
  "li", "ol", "p", "pre", "s", "span", "strong", "sub", "sup", "table", "tbody", "td", "th",
  "thead", "tr", "u", "ul",
]; // prettier-ignore

const STYLES = {
  "*": {
    color: [
      /^#[0-9a-f]{3,8}$/i,
      /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i,
      /^[a-z]+$/i,
    ],
    "background-color": [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i],
    "text-align": [/^(left|right|center|justify)$/],
    "font-weight": [/^(normal|bold|[1-9]00)$/],
    "font-style": [/^(normal|italic)$/],
    "text-decoration": [/^(none|underline|line-through)$/],
    "font-size": [/^\d{1,2}(\.\d)?(px|pt|em|rem|%)$/],
  },
};

export interface SanitizeOptions {
  /** Entfernte Remote-Bilder verhindern Tracking beim Lesen (Standard: false). */
  allowRemoteImages?: boolean;
}

/**
 * Serverseitige HTML-Bereinigung (SR-20): Allowlist für Tags, Attribute und Styles,
 * nur http/https/mailto/tel in Links, keine Skripte, Formulare, iframes, Event-Handler
 * oder `javascript:`-URLs. Links öffnen mit `noopener noreferrer`. Gilt für empfangene
 * Mails (Anzeige) und für ausgehende (nach dem Einsetzen der Platzhalter).
 */
export function sanitizeMailHtml(html: string, opts: SanitizeOptions = {}): string {
  const remote = opts.allowRemoteImages === true;
  return sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      "*": ["style"],
    },
    allowedStyles: STYLES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: remote ? ["https", "cid", "data"] : ["cid", "data"] },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      }),
    },
    exclusiveFilter: (frame) =>
      // data:-Bilder nur als echte Rasterbilder, nichts anderes.
      frame.tag === "img" && /^data:/i.test(frame.attribs["src"] ?? "")
        ? !/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(
            frame.attribs["src"] ?? "",
          )
        : frame.tag === "img" && !frame.attribs["src"],
  });
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
}; // prettier-ignore

/** Klartext-Alternative zu einer HTML-Mail. */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-4])\s*\/?>/gi, "$&\n");
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return stripped
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
