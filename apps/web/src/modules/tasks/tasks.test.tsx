import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test-utils";
import { tasksModule } from ".";
import { createMemoryTasksService } from "./memoryTasksService";
import { TasksApiError, type Task } from "./model";
import { TasksProvider, type TasksService } from "./service";
import { TasksPage } from "./TasksPage";

const pad = (n: number) => String(n).padStart(2, "0");
const d = new Date();
const TODAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const seed: Task[] = [
  { id: "a", title: "Mahnung versenden", due: "2000-01-15" },
  { id: "b", title: "Periode abschliessen", due: TODAY },
  { id: "c", title: "GV planen", due: "2999-12-31" },
  { id: "d", title: "Altlast", due: "2000-01-01", doneAt: "2026-11-03T09:00:00.000Z" },
];

function setup(service: TasksService = createMemoryTasksService(seed)) {
  const view = renderWithProviders(
    <TasksProvider service={service}>
      <TasksPage />
    </TasksProvider>,
  );
  return { ...view, service };
}

describe("Aufgaben", () => {
  it("ist als Modul «tasks» mit Seitenleisten-Eintrag eingetragen", () => {
    expect(tasksModule.id).toBe("tasks");
    expect(tasksModule.tabTypes.map((x) => x.id)).toContain(tasksModule.nav.tabType);
  });

  it("zeigt offene Aufgaben nach Fälligkeit mit Status und Anzahl", async () => {
    const { container } = setup();
    expect(screen.getByRole("heading", { name: "Aufgaben" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Offene Aufgaben" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Mahnung versenden",
      "Periode abschliessen",
      "GV planen",
    ]);
    expect(within(rows[0]!).getByText("Überfällig")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Heute")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Offen")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("31.12.2999")).toBeInTheDocument();
    expect(screen.getByText("3 Aufgaben")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("wechselt zu den erledigten Aufgaben ohne «Erledigt»-Schaltfläche", async () => {
    const { container } = setup();
    await screen.findByText("Mahnung versenden");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "done");
    const table = await screen.findByRole("table", { name: "Erledigte Aufgaben" });
    expect(await within(table).findByText("Altlast")).toBeInTheDocument();
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("1 Aufgabe")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("erledigt eine Aufgabe: sie verschwindet aus den offenen und erscheint bei den erledigten", async () => {
    setup();
    await userEvent.click(
      await screen.findByRole("button", { name: "Aufgabe «Mahnung versenden» erledigen" }),
    );
    expect(await screen.findByText("Aufgabe erledigt")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("2 Aufgaben")).toBeInTheDocument());
    expect(
      within(screen.getByRole("table", { name: "Offene Aufgaben" })).queryByText(
        "Mahnung versenden",
      ),
    ).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "done");
    const done = await screen.findByRole("table", { name: "Erledigte Aufgaben" });
    expect(await within(done).findByText("Mahnung versenden")).toBeInTheDocument();
  });

  it("meldet einen Fehler beim Erledigen und lässt die Aufgabe offen", async () => {
    const service = createMemoryTasksService(seed);
    service.complete = () => Promise.reject(new TasksApiError(500));
    setup(service);
    await userEvent.click(
      await screen.findByRole("button", { name: "Aufgabe «GV planen» erledigen" }),
    );
    expect(await screen.findByText("Die Aufgabe konnte nicht erledigt werden")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Offene Aufgaben" });
    expect(within(table).getByText("GV planen")).toBeInTheDocument();
  });

  it("legt eine Aufgabe an (Dialog, Fälligkeit heute vorbelegt)", async () => {
    const service = createMemoryTasksService(seed);
    const create = vi.spyOn(service, "create");
    const { container } = setup(service);
    await screen.findByText("GV planen");
    await userEvent.click(screen.getByRole("button", { name: "Aufgabe anlegen" }));
    const dialog = await screen.findByRole("dialog", { name: "Aufgabe anlegen" });
    expect(await axe(dialog)).toHaveNoViolations();
    const due = within(dialog).getByLabelText(/Fällig am/) as HTMLInputElement;
    expect(due.value).toBe(TODAY);
    await userEvent.type(within(dialog).getByLabelText(/^Aufgabe/), "  Neue Sache  ");
    await userEvent.clear(due);
    await userEvent.type(due, "2999-01-02");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ title: "Neue Sache", due: "2999-01-02" }),
    );
    expect(await screen.findByText("Aufgabe angelegt")).toBeInTheDocument();
    expect(await screen.findByText("4 Aufgaben")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("verlangt Titel und Datum und ruft die API nicht auf, solange sie fehlen", async () => {
    const service = createMemoryTasksService(seed);
    const create = vi.spyOn(service, "create");
    setup(service);
    await userEvent.click(await screen.findByRole("button", { name: "Aufgabe anlegen" }));
    const dialog = await screen.findByRole("dialog");
    const due = within(dialog).getByLabelText(/Fällig am/);
    await userEvent.clear(due);
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(within(dialog).getByText(/Geben Sie die Aufgabe ein/)).toBeInTheDocument();
    expect(within(dialog).getByText("Wählen Sie ein Datum.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("zeigt einen Fehler beim Speichern im Dialog und behält die Eingabe", async () => {
    const service = createMemoryTasksService(seed);
    service.create = () => Promise.reject(new TasksApiError(500));
    setup(service);
    await userEvent.click(await screen.findByRole("button", { name: "Aufgabe anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^Aufgabe/), "Wichtig");
    await userEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(await within(dialog).findByText(/konnte nicht gespeichert werden/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Aufgabe/)).toHaveValue("Wichtig");
  });

  it("zeigt den Leer-Zustand mit «Aufgabe anlegen»", async () => {
    const { container } = setup(createMemoryTasksService([]));
    expect(await screen.findByText("Keine offenen Aufgaben")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Aufgabe anlegen" })).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("zeigt den Fehlerzustand mit «Erneut laden» und lädt neu", async () => {
    const service = createMemoryTasksService(seed);
    const list = vi.spyOn(service, "list").mockRejectedValueOnce(new TasksApiError(500));
    const { container } = setup(service);
    expect(
      await screen.findByText("Die Aufgaben konnten nicht geladen werden"),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByRole("button", { name: /Erneut laden/ }));
    expect(await screen.findByText("GV planen")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("weist darauf hin, wenn nicht alle Aufgaben geladen sind", async () => {
    const service = createMemoryTasksService(seed);
    service.list = async () => ({ items: [{ id: "x", title: "Eine", due: TODAY }], total: 250 });
    setup(service);
    expect(await screen.findByText("Es werden 1 von 250 Aufgaben angezeigt.")).toBeInTheDocument();
  });
});
