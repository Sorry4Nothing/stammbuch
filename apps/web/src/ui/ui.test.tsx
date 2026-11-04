import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { axe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Message,
  OtpInput,
  PageTabs,
  RadioGroup,
  Select,
  Switch,
  TextArea,
  TextField,
  ToastProvider,
  useToast,
  type Column,
} from ".";

describe("Button", () => {
  it("löst onClick aus und ist standardmässig kein Submit", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Speichern</Button>);
    const btn = screen.getByRole("button", { name: "Speichern" });
    expect(btn).toHaveAttribute("type", "button");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("Nur-Symbol-Schaltfläche trägt ihren Namen im aria-label", () => {
    render(<Button icon="print" aria-label="Drucken" />);
    expect(screen.getByRole("button", { name: "Drucken" })).toHaveClass("btn--icon");
  });

  it("deaktiviert reagiert nicht", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Versenden
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Felder", () => {
  it("verbindet Label, Hinweis und Fehler mit dem Feld", () => {
    render(<TextField label="E-Mail" required hint="Für die Rechnung" error="Ungültig" />);
    const input = screen.getByLabelText("E-Mail (Pflicht)");
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Ungültig Für die Rechnung");
  });

  it("ohne Fehler kein aria-invalid", () => {
    render(<TextField label="Name" />);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
  });

  it("TextArea und Select sind beschriftet", async () => {
    render(
      <>
        <TextArea label="Bemerkung" />
        <Select
          label="Gruppe"
          options={[
            { value: "a", label: "Vorstand" },
            { value: "b", label: "Helferteam" },
          ]}
        />
      </>,
    );
    await userEvent.type(screen.getByLabelText("Bemerkung"), "Hallo");
    expect(screen.getByLabelText("Bemerkung")).toHaveValue("Hallo");
    await userEvent.selectOptions(screen.getByLabelText("Gruppe"), "Helferteam");
    expect(screen.getByLabelText("Gruppe")).toHaveValue("b");
  });

  it("Checkbox ist per Leertaste bedienbar", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Willkommensmail senden" onChange={onChange} />);
    await userEvent.tab();
    expect(screen.getByRole("checkbox", { name: "Willkommensmail senden" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("RadioGroup wechselt mit den Pfeiltasten", async () => {
    function Demo() {
      const [v, setV] = useState("einzel");
      return (
        <RadioGroup
          legend="Art"
          name="art"
          value={v}
          onChange={setV}
          options={[
            { value: "einzel", label: "Einzelmitglied" },
            { value: "firma", label: "Firmenmitglied" },
          ]}
        />
      );
    }
    render(<Demo />);
    const group = screen.getByRole("group", { name: "Art" });
    expect(within(group).getByRole("radio", { name: "Einzelmitglied" })).toBeChecked();
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");
    expect(within(group).getByRole("radio", { name: "Firmenmitglied" })).toBeChecked();
  });

  it("Switch meldet seinen Zustand", async () => {
    function Demo() {
      const [on, setOn] = useState(false);
      return <Switch label="Modul Mail" checked={on} onChange={setOn} text={on ? "Ein" : "Aus"} />;
    }
    render(<Demo />);
    const sw = screen.getByRole("switch", { name: "Modul Mail" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = render(
      <form>
        <TextField label="Name" hint="Hinweis" />
        <TextField label="E-Mail" error="Fehler" />
        <TextArea label="Bemerkung" />
        <Select label="Gruppe" options={[{ value: "a", label: "A" }]} />
        <Checkbox label="Ja" />
        <RadioGroup
          legend="Art"
          name="x"
          value="a"
          onChange={() => {}}
          options={[{ value: "a", label: "A" }]}
        />
      </form>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Message und Badge", () => {
  it("Fehler ist role=alert, der Rest role=status", () => {
    render(
      <>
        <Message tone="error" title="Fehler.">
          Import fehlgeschlagen
        </Message>
        <Message tone="ok" title="Gespeichert." />
        <Badge tone="warning">Mahnstufe 2</Badge>
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Fehler. Import fehlgeschlagen");
    expect(screen.getByRole("status")).toHaveTextContent("Gespeichert.");
    expect(screen.getByText("Mahnstufe 2")).toHaveClass("badge--warning");
  });
});

interface Row {
  id: string;
  name: string;
  amount: string;
}
const rows: Row[] = [
  { id: "1", name: "Anna", amount: "CHF 120.00" },
  { id: "2", name: "Beat", amount: "CHF 60.00" },
  { id: "3", name: "Claudia", amount: "CHF 1'250.00" },
];
const columns: Column<Row>[] = [
  { key: "name", header: "Name", sortable: true, cell: (r) => r.name },
  { key: "amount", header: "Betrag", align: "right", cell: (r) => r.amount },
];

describe("DataTable", () => {
  it("zeigt Kopf und Zeilen, Beträge rechtsbündig", () => {
    render(<DataTable label="Personen" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const table = screen.getByRole("table", { name: "Personen" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("columnheader", { name: "Betrag" })).toHaveClass("r");
  });

  it("zeigt den leeren Zustand", () => {
    render(
      <DataTable
        label="Personen"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty="Keine Einträge"
      />,
    );
    expect(screen.getByText("Keine Einträge")).toBeInTheDocument();
  });

  it("Sortierung per Klick und aria-sort", async () => {
    const onSort = vi.fn();
    render(
      <DataTable
        label="Personen"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={onSort}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenCalledWith({ key: "name", direction: "desc" });
  });

  it("Tastatur: Pfeile bewegen, Enter öffnet, Leertaste wählt, Strg+A wählt alle", async () => {
    const onActivate = vi.fn();
    function Demo() {
      const [sel, setSel] = useState<Set<string>>(new Set());
      return (
        <>
          <DataTable
            label="Personen"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            selectable
            selected={sel}
            onSelectedChange={setSel}
            onRowActivate={onActivate}
          />
          <output data-testid="count">{sel.size}</output>
        </>
      );
    }
    render(<Demo />);
    const body = screen.getAllByRole("row").slice(1);
    // Die erste Zeile ist per Tab erreichbar (roving tabindex): Auswahlfeld im Kopf, dann Zeile.
    body[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(body[1]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(body[2]).toHaveFocus();
    await userEvent.keyboard("{Home}{ArrowDown}");
    await userEvent.keyboard(" ");
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    expect(within(body[1]!).getByRole("checkbox")).toBeChecked();
    await userEvent.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledWith(rows[1]);
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(screen.getByTestId("count")).toHaveTextContent("3");
    expect(screen.getByRole("checkbox", { name: "Alle Zeilen auswählen" })).toBeChecked();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    const { container } = render(
      <DataTable label="Personen" columns={columns} rows={rows} rowKey={(r) => r.id} selectable />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Dialog", () => {
  function Demo({ onClose = () => {} }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Öffnen</button>
        <main>
          <button>Dahinter</button>
        </main>
        {open && (
          <Dialog
            title="Gruppe auflösen?"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            footer={<Button variant="danger">Auflösen</Button>}
          >
            <TextField label="Name" />
          </Dialog>
        )}
      </>
    );
  }

  it("ist modal, beschriftet, fokussiert das erste Feld und gibt den Fokus zurück", async () => {
    render(<Demo />);
    const opener = screen.getByRole("button", { name: "Öffnen" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Gruppe auflösen?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Name")).toHaveFocus();
    // Der Rest der Seite ist inaktiv.
    expect(document.body.querySelector("main")?.parentElement).toHaveAttribute("inert");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(opener.parentElement).not.toHaveAttribute("inert");
  });

  it("hält den Fokus mit Tab und Umschalt+Tab im Dialog", async () => {
    render(<Demo />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const name = screen.getByLabelText("Name");
    const action = screen.getByRole("button", { name: "Auflösen" });
    await userEvent.tab();
    expect(action).toHaveFocus();
    await userEvent.tab();
    expect(name).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(action).toHaveFocus();
  });

  it("Esc schliesst nur den obersten Dialog", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Stacked() {
      const [open, setOpen] = useState(false);
      return (
        <Dialog title="Aussen" onClose={outer}>
          <button onClick={() => setOpen(true)}>Weiter</button>
          {open && (
            <Dialog title="Innen" onClose={inner}>
              <button>x</button>
            </Dialog>
          )}
        </Dialog>
      );
    }
    render(<Stacked />);
    await userEvent.click(screen.getByRole("button", { name: "Weiter" }));
    await userEvent.keyboard("{Escape}");
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it("Formular-Dialog löst mit Enter die Hauptaktion aus", async () => {
    const onSubmit = vi.fn();
    render(
      <Dialog
        title="Anmelden"
        onClose={() => {}}
        onSubmit={onSubmit}
        footer={
          <Button type="submit" variant="primary">
            OK
          </Button>
        }
      >
        <TextField label="Code" />
      </Dialog>,
    );
    await userEvent.type(screen.getByLabelText("Code"), "123{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("hat keine Zugänglichkeitsverstösse", async () => {
    render(<Demo />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(await axe(screen.getByRole("dialog"))).toHaveNoViolations();
  });
});

describe("ConfirmDialog", () => {
  it("beginnt beim Abbrechen und bestätigt gefährliche Aktionen mit der roten Schaltfläche", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Gruppe «Vorstand» auflösen?"
        confirmLabel="Gruppe auflösen"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Die Gruppe hat 7 Personen.
      </ConfirmDialog>,
    );
    expect(screen.getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Gruppe auflösen" })).toHaveClass("btn--danger");
    await userEvent.click(screen.getByRole("button", { name: "Gruppe auflösen" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  function Demo() {
    const toast = useToast();
    return (
      <button
        onClick={() => toast.show({ tone: "ok", title: "Gespeichert.", text: "Aktualisiert." })}
      >
        Speichern
      </button>
    );
  }

  it("erscheint, verschwindet nach 5 Sekunden und lässt sich schliessen", async () => {
    render(
      <ToastProvider>
        <Demo />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(screen.getByRole("status")).toHaveTextContent("Gespeichert. Aktualisiert.");
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await userEvent.click(screen.getByRole("button", { name: "Meldung schliessen" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("useToast ohne Provider wirft einen klaren Fehler", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Demo />)).toThrow("ToastProvider");
    spy.mockRestore();
  });
});

describe("OtpInput", () => {
  function Demo({ onComplete }: { onComplete?: (v: string) => void }) {
    const [v, setV] = useState("");
    return <OtpInput label="Einmalcode" value={v} onChange={setV} onComplete={onComplete} />;
  }

  it("springt beim Tippen weiter und meldet den vollständigen Code", async () => {
    const onComplete = vi.fn();
    render(<Demo onComplete={onComplete} />);
    const digits = screen.getAllByRole("textbox");
    expect(digits).toHaveLength(6);
    digits[0]!.focus();
    await userEvent.keyboard("482916");
    expect(digits.map((d) => (d as HTMLInputElement).value).join("")).toBe("482916");
    expect(onComplete).toHaveBeenCalledWith("482916");
  });

  it("ignoriert Buchstaben, Rücktaste geht zurück", async () => {
    render(<Demo />);
    const digits = screen.getAllByRole("textbox") as HTMLInputElement[];
    digits[0]!.focus();
    await userEvent.keyboard("4a8");
    expect(digits[0]).toHaveValue("4");
    expect(digits[1]).toHaveValue("8");
    await userEvent.keyboard("{Backspace}");
    expect(digits[1]).toHaveValue("");
    await userEvent.keyboard("{Backspace}");
    expect(digits[0]).toHaveValue("");
  });

  it("verteilt eingefügten Code auf die Felder", async () => {
    render(<Demo />);
    const digits = screen.getAllByRole("textbox") as HTMLInputElement[];
    digits[0]!.focus();
    await userEvent.paste("12 34-56");
    expect(digits.map((d) => d.value).join("")).toBe("123456");
  });

  it("ist als Gruppe beschriftet und hat keine Verstösse", async () => {
    const { container } = render(<Demo />);
    expect(screen.getByRole("group", { name: "Einmalcode" })).toBeInTheDocument();
    expect(screen.getByLabelText("Ziffer 1 von 6")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("PageTabs", () => {
  it("wechselt mit den Pfeiltasten und zeigt das passende Panel", async () => {
    function Demo() {
      const [v, setV] = useState("a");
      return (
        <PageTabs
          label="Einstellungen"
          value={v}
          onChange={setV}
          tabs={[
            { id: "a", label: "Stammdaten", content: <p>Inhalt A</p> },
            { id: "b", label: "Module", content: <p>Inhalt B</p> },
          ]}
        />
      );
    }
    render(<Demo />);
    expect(screen.getByRole("tabpanel", { name: "Stammdaten" })).toHaveTextContent("Inhalt A");
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Module" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Module" })).toHaveTextContent("Inhalt B");
  });
});

describe("EmptyState und ErrorState", () => {
  it("EmptyState zeigt Titel, Text und Aktion", () => {
    render(
      <EmptyState
        icon="invoice"
        title="Noch keine Rechnungen"
        text="Sobald Sie die erste Rechnung erstellen, erscheint sie hier."
        actions={<Button variant="primary">Rechnung erstellen</Button>}
      />,
    );
    expect(screen.getByText("Noch keine Rechnungen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechnung erstellen" })).toBeInTheDocument();
  });

  it("ErrorState zeigt Details, lädt erneut und kopiert die Fehlernummer", async () => {
    const onRetry = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ToastProvider>
        <ErrorState
          title="Die Liste konnte nicht geladen werden"
          text="Der Server hat nicht rechtzeitig geantwortet."
          message="Zeitüberschreitung (504)"
          at={new Date(2026, 10, 2, 14, 30, 12)}
          errorId="ERR-20261102-4F7A"
          onRetry={onRetry}
        />
      </ToastProvider>,
    );
    expect(screen.getByText("02.11.2026 · 14:30:12")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Fehlernummer kopieren" }));
    expect(writeText).toHaveBeenCalledWith("ERR-20261102-4F7A");
    expect(await screen.findByText("Fehlernummer kopiert.")).toBeInTheDocument();
  });
});
