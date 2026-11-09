import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { t, tp } from "../../i18n";
import { useCurrentTab } from "../../shell/tabs";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Icon,
  Message,
  PageHeader,
  Panel,
  useToast,
} from "../../ui";
import { FormSelect, Kv, notifyChange, useAsync } from "./components";
import { formatInt } from "./format";
import type { ImportAuftrag, ImportErgebnis, ImportOptionen, ImportZiel } from "./model";
import { usePersonen } from "./service";

/** Grenzen der API (Datei 2 MB, 5000 Zeilen). */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

/** Zerlegt CSV (Trenner `;`, `,` oder Tab, Anführungszeichen nach RFC 4180). */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = [";", ",", "\t"].reduce((best, d) =>
    first.split(d).length > first.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");

/** Vorschlag für die Zuordnung anhand des Spaltennamens. */
export function guessTarget(name: string, groupSupported: boolean): ImportZiel {
  const k = fold(name);
  if (k === "vorname") return "vorname";
  if (k === "nachname" || k === "name") return "nachname";
  if (k.startsWith("strasse")) return "strasse";
  if (k === "plzort" || k === "ort") return "plzOrt";
  if (k === "mail" || k === "email" || k === "emailadresse") return "email";
  if (k === "gruppe" && groupSupported) return "gruppe";
  return "ignorieren";
}

const TARGETS: ImportZiel[] = [
  "vorname",
  "nachname",
  "strasse",
  "plzOrt",
  "email",
  "gruppe",
  "ignorieren",
];

interface Loaded {
  name: string;
  raw: string[][];
}

/** Personen importieren: Spalten zuordnen, prüfen, importieren (Design 3.15). */
export function ImportPage() {
  const svc = usePersonen();
  const tab = useCurrentTab();
  const toast = useToast();
  const x = svc.features.importOptionen;
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<Loaded | null>(null);
  const [readError, setReadError] = useState(false);
  const [mapping, setMapping] = useState<ImportZiel[]>([]);
  const [options, setOptions] = useState<ImportOptionen>({
    ersteZeileNamen: true,
    duplikatePruefen: true,
    aktualisieren: false,
    gruppeFuerAlle: null,
  });
  const [step, setStep] = useState<2 | 3>(2);
  const [result, setResult] = useState<ImportErgebnis | null>(null);
  const [problem, setProblem] = useState<"mapping" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const gruppen = useAsync(() => (x ? svc.listGruppen() : Promise.resolve([])), [svc, x]);

  const spalten = useMemo(() => {
    if (!file) return [];
    const width = Math.max(...file.raw.map((r) => r.length), 0);
    const head = options.ersteZeileNamen ? (file.raw[0] ?? []) : [];
    return Array.from(
      { length: width },
      (_, i) => head[i]?.trim() || t("personen.import.column", { n: i + 1 }),
    );
  }, [file, options.ersteZeileNamen]);
  const zeilen = useMemo(
    () => (file ? file.raw.slice(options.ersteZeileNamen ? 1 : 0) : []),
    [file, options.ersteZeileNamen],
  );

  const choose = () => input.current?.click();
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setReadError(false);
    try {
      if (f.size > MAX_BYTES || !/\.(csv|txt)$/i.test(f.name)) throw new Error("Datei");
      const raw = parseCsv(await f.text());
      if (raw.length === 0 || raw.length > MAX_ROWS + 1) throw new Error("Zeilen");
      const head = raw[0] ?? [];
      setFile({ name: f.name, raw });
      setMapping(head.map((h) => guessTarget(h, x)));
      setStep(2);
      setResult(null);
      setProblem(null);
    } catch {
      setReadError(true);
    }
  };

  const target = (i: number): ImportZiel => mapping[i] ?? "ignorieren";
  const taken = (z: ImportZiel) => z !== "ignorieren" && mapping.filter((m) => m === z).length;
  const mappingOk =
    mapping.includes("vorname") &&
    mapping.includes("nachname") &&
    TARGETS.every((z) => !taken(z) || taken(z) === 1);

  const auftrag = (): ImportAuftrag => ({
    datei: { name: file?.name ?? "", zeilen, spalten },
    zuordnung: spalten.map((_, i) => target(i)),
    optionen: options,
  });

  const check = async () => {
    if (!file) return;
    if (!mappingOk) {
      setProblem("mapping");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      setResult(await svc.importPruefen(auftrag()));
      setStep(3);
    } catch {
      setProblem("failed");
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await svc.importAusfuehren(auftrag());
      notifyChange();
      toast.show({ tone: "ok", title: tp("personen.import.done", r.neu) });
      tab.close();
    } catch {
      setProblem("failed");
      setBusy(false);
    }
  };

  const groupCol = mapping.indexOf("gruppe");
  const multi = groupCol < 0 ? 0 : zeilen.filter((r) => /[;,|/]/.test(r[groupCol] ?? "")).length;
  // Die API importiert alles oder nichts: jede fehlerhafte Zeile und jede doppelte E-Mail-Adresse stoppt den Import.
  const blocked = result !== null && (result.fehlerhaft > 0 || (!x && result.duplikate > 0));

  const stepBadge = (n: 1 | 2 | 3) => {
    const state = !file
      ? n === 1
        ? "current"
        : "todo"
      : n < step
        ? "done"
        : n === step
          ? "current"
          : "todo";
    const label =
      n === 1
        ? t(file ? "personen.import.step1" : "personen.import.step1.choose")
        : t(`personen.import.step${n}` as "personen.import.step2");
    if (state === "current") return <span className="badge badge--current">{label}</span>;
    if (state === "done") {
      return (
        <Badge tone="ok">
          <Icon name="check" size={14} /> {label}
        </Badge>
      );
    }
    return <Badge>{label}</Badge>;
  };

  return (
    <div className="page">
      <input
        ref={input}
        className="file-input"
        type="file"
        accept=".csv,.txt,text/csv"
        aria-label={t("personen.import.fileLabel")}
        tabIndex={-1}
        onChange={(e) => void onFile(e)}
      />
      <PageHeader
        crumb={t("personen.import.crumb")}
        title={t("personen.import.title")}
        actions={
          <>
            <Button icon="chevronLeft" onClick={choose}>
              {t("personen.import.other")}
            </Button>
            {step === 2 || !result ? (
              <Button
                variant="primary"
                icon="arrowRight"
                disabled={!file || busy}
                onClick={() => void check()}
              >
                {t("personen.import.check")}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="upload"
                disabled={busy || blocked || result.neu === 0}
                onClick={() => void run()}
              >
                {t("personen.import.run")}
              </Button>
            )}
          </>
        }
      />
      <div className="pad-top pad-x">
        <ol className="steps" aria-label={t("personen.import.steps")}>
          <li>{stepBadge(1)}</li>
          <li>
            <span className="muted" aria-hidden="true">
              <Icon name="chevronRight" size={14} />
            </span>
          </li>
          <li aria-current={file && step === 2 ? "step" : undefined}>{stepBadge(2)}</li>
          <li>
            <span className="muted" aria-hidden="true">
              <Icon name="chevronRight" size={14} />
            </span>
          </li>
          <li aria-current={file && step === 3 ? "step" : undefined}>{stepBadge(3)}</li>
        </ol>
      </div>

      {!file ? (
        <div className="pad-form">
          {readError && (
            <Message tone="error" title={t("personen.import.readError.title")}>
              {t("personen.import.readError.text")}
            </Message>
          )}
          <Panel title={t("personen.import.start.title")}>
            <EmptyState
              title={t("personen.import.start.empty")}
              text={t("personen.import.start.text")}
              actions={
                <Button variant="primary" icon="upload" onClick={choose}>
                  {t("personen.import.start.choose")}
                </Button>
              }
            />
          </Panel>
        </div>
      ) : (
        <div className="cols">
          <div className="cols__a stack">
            {readError && (
              <Message tone="error" title={t("personen.import.readError.title")}>
                {t("personen.import.readError.text")}
              </Message>
            )}
            {problem === "mapping" && (
              <Message tone="error" title={t("personen.import.mapping.title")}>
                {t("personen.import.mapping.text")}
              </Message>
            )}
            {problem === "failed" && <Message tone="error" title={t("personen.import.failed")} />}
            <Message tone="ok" title={t("personen.import.read.title")}>
              {t("personen.import.read.text", {
                name: file.name,
                rows: formatInt(zeilen.length),
                cols: spalten.length,
              })}
            </Message>
            {result && step === 3 && (
              <Message
                tone={blocked ? "error" : "ok"}
                title={t(blocked ? "personen.import.blocked.title" : "personen.import.ready.title")}
              >
                {blocked
                  ? t("personen.import.blocked.text", {
                      rows:
                        result.fehler
                          .map((f) => `${f.zeile} (${f.felder.join(", ")})`)
                          .join(", ") || "–",
                    })
                  : tp("personen.import.ready.text", result.neu)}
              </Message>
            )}
            <Panel title={t("personen.import.mapping")} flush>
              <table className="tbl" aria-label={t("personen.import.mapping.table")}>
                <colgroup>
                  <col className="col-import-a" />
                  <col className="col-import-b" />
                  <col className="col-import-c" />
                  <col className="col-import-d" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">{t("personen.import.col.file")}</th>
                    <th scope="col">{t("personen.import.col.example")}</th>
                    <th scope="col">{t("personen.import.col.target")}</th>
                    <th scope="col">{t("personen.import.col.required")}</th>
                  </tr>
                </thead>
                <tbody>
                  {spalten.map((name, i) => (
                    <tr key={`${i}-${name}`}>
                      <td>{name}</td>
                      <td>{zeilen[0]?.[i] ?? "–"}</td>
                      <td>
                        <span className="sel">
                          <select
                            className="in"
                            aria-label={t("personen.import.assign", { name })}
                            value={target(i)}
                            onChange={(e) => {
                              const v = e.target.value as ImportZiel;
                              setMapping((m) =>
                                spalten.map((_, k) => (k === i ? v : (m[k] ?? "ignorieren"))),
                              );
                              setResult(null);
                              setStep(2);
                            }}
                          >
                            {TARGETS.filter((z) => z !== "gruppe" || x).map((z) => (
                              <option key={z} value={z}>
                                {t(
                                  `personen.import.target.${z}` as "personen.import.target.vorname",
                                )}
                              </option>
                            ))}
                          </select>
                          <Icon name="chevronDown" />
                        </span>
                      </td>
                      <td>
                        {target(i) === "vorname" || target(i) === "nachname"
                          ? t("personen.import.yes")
                          : t("personen.import.no")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
          <div className="cols__b stack">
            <Panel title={t("personen.import.options")}>
              <div className="opt-list">
                <Checkbox
                  label={t("personen.import.opt.header")}
                  checked={options.ersteZeileNamen}
                  onChange={(e) => {
                    setOptions((o) => ({ ...o, ersteZeileNamen: e.target.checked }));
                    setResult(null);
                    setStep(2);
                  }}
                />
                {x && (
                  <>
                    <Checkbox
                      label={t("personen.import.opt.duplicates")}
                      checked={options.duplikatePruefen}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, duplikatePruefen: e.target.checked }))
                      }
                    />
                    <Checkbox
                      label={t("personen.import.opt.update")}
                      checked={options.aktualisieren}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, aktualisieren: e.target.checked }))
                      }
                    />
                    <FormSelect
                      label={t("personen.import.opt.group")}
                      value={options.gruppeFuerAlle ?? ""}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, gruppeFuerAlle: e.target.value || null }))
                      }
                      options={[
                        { value: "", label: t("personen.form.gruppe.keine") },
                        ...(gruppen.data ?? []).map((g) => ({ value: g.id, label: g.name })),
                      ]}
                    />
                  </>
                )}
              </div>
            </Panel>
            {multi > 0 && (
              <Message tone="warning" title={t("personen.hint.eineGruppe.title")}>
                {tp("personen.import.multiGroup", multi)}
              </Message>
            )}
            <Panel title={t("personen.import.preview")}>
              <Kv
                rows={[
                  [t("personen.import.preview.rows"), formatInt(zeilen.length)],
                  [t("personen.import.preview.new"), result ? formatInt(result.neu) : "–"],
                  [t("personen.import.preview.dup"), result ? formatInt(result.duplikate) : "–"],
                  [t("personen.import.preview.err"), result ? formatInt(result.fehlerhaft) : "–"],
                ]}
              />
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
