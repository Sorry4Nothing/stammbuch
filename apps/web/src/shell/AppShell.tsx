import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { SessionExpiredDialog } from "../auth/SessionExpiredDialog";
import { useAuth } from "../auth/auth";
import { t } from "../i18n";
import { MODULE_IDS, type ModuleDefinition, type SearchHit } from "../modules/types";
import { Button, ConfirmDialog, KbdText, Message } from "../ui";
import { Footer } from "./Footer";
import { GlobalSearch } from "./GlobalSearch";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { TabPanels } from "./TabPanels";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useGlobalShortcuts } from "./shortcuts";
import { TabsProvider, useTabs } from "./tabs";

function CustomerFrame() {
  const tabs = useTabs();
  const auth = useAuth();
  const navigate = useNavigate();
  const [overlay, setOverlay] = useState<"search" | "shortcuts" | null>(null);

  const providers = useMemo(() => tabs.modules.flatMap((m) => m.search ?? []), [tabs.modules]);

  const create = useCallback(() => {
    const mod = tabs.modules.find((m) => m.id === tabs.active?.moduleId);
    if (mod?.newTabType) tabs.openTab(mod.newTabType);
  }, [tabs]);

  useGlobalShortcuts({
    search: () => setOverlay("search"),
    overview: () => setOverlay("shortcuts"),
    create,
    save: () => void tabs.saveActive(),
    nextTab: () => tabs.cycle(1),
    prevTab: () => tabs.cycle(-1),
    closeTab: () => tabs.active && tabs.requestClose(tabs.active.id),
    tabNumber: (n) => tabs.activateIndex(n - 1),
  });

  const openHit = (hit: SearchHit) => {
    setOverlay(null);
    tabs.openTab(hit.open.tabType, {
      key: hit.open.key,
      params: hit.open.params,
      title: hit.open.title,
    });
  };

  const createPerson = tabs.moduleOpener(MODULE_IDS.people, "new");

  const pending = tabs.pendingClose;
  const pendingTitle = pending
    ? (pending.title ?? t(tabs.tabType(pending)?.titleKey ?? "app.title"))
    : "";
  const pendingSave = pending ? tabs.canSave(pending.id) : false;

  return (
    <div className="app">
      <a className="skip" href="#main">
        {t("shell.skip")}
      </a>
      <Sidebar
        onLogout={async () => {
          await auth.signOut();
          navigate("/anmelden");
        }}
      />
      <div className="main">
        <TabBar />
        <main id="main" className="work" tabIndex={-1}>
          <TabPanels />
        </main>
        <Footer onSearch={() => setOverlay("search")} />
      </div>

      {overlay === "search" && (
        <GlobalSearch
          providers={providers}
          onClose={() => setOverlay(null)}
          onOpen={openHit}
          onCreatePerson={
            createPerson &&
            (() => {
              setOverlay(null);
              createPerson();
            })
          }
        />
      )}
      {overlay === "shortcuts" && <ShortcutsDialog onClose={() => setOverlay(null)} />}

      {pending && (
        <ConfirmDialog
          title={t("shell.closeDirty.title", { title: pendingTitle })}
          width={640}
          top={190}
          // Ohne Speicher-Handler (Tab kann nicht selbst speichern) bleibt nur Verwerfen oder Abbrechen.
          danger={!pendingSave}
          confirmLabel={pendingSave ? t("shell.closeDirty.save") : t("shell.closeDirty.discard")}
          confirmIcon={pendingSave ? "save" : "trash"}
          onConfirm={() => void tabs.confirmClose(pendingSave ? "save" : "discard")}
          onCancel={tabs.cancelClose}
          extra={
            pendingSave ? (
              <Button
                variant="danger"
                icon="trash"
                onClick={() => void tabs.confirmClose("discard")}
              >
                {t("shell.closeDirty.discard")}
              </Button>
            ) : undefined
          }
        >
          <Message tone="warning" title={t("shell.closeDirty.alertTitle")}>
            {pending.dirtySubject
              ? t("shell.closeDirty.alertTextSubject", {
                  title: pendingTitle,
                  subject: pending.dirtySubject,
                })
              : t("shell.closeDirty.alertText", { title: pendingTitle })}
          </Message>
          <span className="muted">
            <KbdText>
              {t(pendingSave ? "shell.closeDirty.hint" : "shell.closeDirty.hintNoSave")}
            </KbdText>
          </span>
        </ConfirmDialog>
      )}

      {auth.expired && <SessionExpiredDialog />}
    </div>
  );
}

/**
 * App-Rahmen (Design 2.1): Seitenleiste, Tab-Leiste, Arbeitsfläche, Fusszeile.
 * Die Module kommen als Parameter, damit Tests mit eigenen Modulen arbeiten können.
 */
export function AppShell({ modules }: { modules: readonly ModuleDefinition[] }) {
  const { session } = useAuth();
  const chef = session?.role === "chief_admin";
  // Jede Rolle sieht nur ihre Module: der Chef-Admin nie die Kundenmodule und umgekehrt (SR-12).
  const own = modules.filter((m) => (m.audience ?? "customer") === (chef ? "chef" : "customer"));
  if (chef) {
    const Frame = own.find((m) => m.frame)?.frame;
    return Frame ? <Frame /> : null;
  }
  return (
    <TabsProvider modules={own}>
      <CustomerFrame />
    </TabsProvider>
  );
}
