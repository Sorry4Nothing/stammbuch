import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateField } from "./DateField";

function Harness({ initial = "" }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <DateField label="Datum" required value={v} onChange={setV} placeholder="TT.MM.JJJJ" />;
}

const proto = HTMLInputElement.prototype as unknown as { showPicker?: () => void };

afterEach(() => {
  delete proto.showPicker;
});

describe("DateField", () => {
  it("bleibt ohne Kalender-Unterstützung ein reines Textfeld", async () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Kalender öffnen" })).toBeNull();
    await userEvent.type(screen.getByLabelText(/Datum/), "01.02.2027");
    expect(screen.getByLabelText(/Datum/)).toHaveValue("01.02.2027");
  });

  it("öffnet den Kalender mit dem getippten Datum und übernimmt die Wahl als TT.MM.JJJJ", async () => {
    const show = vi.fn();
    proto.showPicker = show;
    const { container } = render(<Harness initial="5.3.2027" />);
    const button = screen.getByRole("button", { name: "Kalender öffnen" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(show).toHaveBeenCalledOnce();
    const native = container.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(native).toHaveValue("2027-03-05");
    expect(native).toHaveAttribute("aria-hidden", "true");
    expect(native.tabIndex).toBe(-1);
    fireEvent.change(native, { target: { value: "2027-12-24" } });
    expect(screen.getByLabelText(/Datum/)).toHaveValue("24.12.2027");
    expect(screen.getByLabelText(/Datum/)).toHaveFocus();
  });

  it("startet den Kalender leer, wenn das Datum nicht lesbar ist, und fängt eine Ablehnung ab", async () => {
    proto.showPicker = () => {
      throw new DOMException("blockiert", "NotAllowedError");
    };
    const { container } = render(<Harness initial="31.02.2027" />);
    await userEvent.click(screen.getByRole("button", { name: "Kalender öffnen" }));
    expect(container.querySelector('input[type="date"]')).toHaveValue("");
  });

  it("ist per Tastatur erreichbar und hat keine Zugänglichkeitsverstösse", async () => {
    proto.showPicker = vi.fn();
    const { container } = render(<Harness />);
    await userEvent.tab();
    expect(screen.getByLabelText(/Datum/)).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Kalender öffnen" })).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });
});
