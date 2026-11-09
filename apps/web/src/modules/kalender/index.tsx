import type { ComponentType } from "react";
import type { ModuleDefinition, ModuleTabType } from "../types";
import type { CalendarService } from "./calendarService";
import { CalendarProvider } from "./CalendarContext";
import { CalendarPage } from "./CalendarPage";
import { EventTab } from "./EventPage";
import { InviteTab } from "./InvitePage";
import { ParticipantsTab } from "./ParticipantsPage";
import { ResponsesTab } from "./ResponsesPage";
import "./kalender.css";

/** Jeder Tab bekommt den Kalender-Dienst; ohne Angabe spricht er mit der API. */
function withService(
  service: CalendarService | undefined,
  now: number | undefined,
  Page: ComponentType,
): ModuleTabType["component"] {
  return function CalendarTabPage() {
    return (
      <CalendarProvider service={service} now={now}>
        <Page />
      </CalendarProvider>
    );
  };
}

/**
 * Modul «Kalender» (Design 8.1 bis 8.7). Tests übergeben einen eigenen Dienst
 * (`createMemoryCalendarService`); die Anwendung nutzt `kalenderModule`.
 */
export function createKalenderModule(service?: CalendarService, now?: number): ModuleDefinition {
  return {
    id: "calendar",
    titleKey: "module.calendar.title",
    nav: { labelKey: "module.calendar.nav", icon: "calendar", order: 60, tabType: "calendar" },
    newTabType: "calendar-event",
    tabTypes: [
      {
        id: "calendar",
        titleKey: "module.calendar.title",
        component: withService(service, now, CalendarPage),
      },
      {
        id: "calendar-event",
        titleKey: "kalender.tab.new",
        component: withService(service, now, EventTab),
      },
      {
        id: "calendar-invite",
        titleKey: "kalender.invite.title",
        component: withService(service, now, InviteTab),
      },
      {
        id: "calendar-participants",
        titleKey: "kalender.participants.tab",
        component: withService(service, now, ParticipantsTab),
      },
      {
        id: "calendar-responses",
        titleKey: "kalender.responses.tab",
        component: withService(service, now, ResponsesTab),
      },
    ],
  };
}

export const kalenderModule = createKalenderModule();
