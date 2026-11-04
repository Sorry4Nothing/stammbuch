import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { SessionExpiredDialog } from "../auth/SessionExpiredDialog";
import { useAuth } from "../auth/auth";
import { t } from "../i18n";
import type { ModuleDefinition, SearchHit } from "../modules/types";
import { Button, ConfirmDialog, Message } from "../ui";
import { Footer } from "./Footer";
import { GlobalSearch } from "./GlobalSearch";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { TabPanels } from "./TabPanels";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useGlobalShortcuts } from "./shortcuts";
import { TabsProvider, useTabs } from "./tabs";

function Frame() {
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

  const pending = tabs.pendingClose;
  const pendingTitle = pending
    ? (pending.title ?? t(tabs.tabType(pending)?.titleKey ?? "app.title"))
    : "";

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
        <Footer onSearch={() => setOverlay("search")} onOverview={() => setOverlay("shortcuts")} />
      </div>

      {overlay === "search" && (
        <GlobalSearch providers={providers} onClose={() => setOverlay(null)} onOpen={openHit} />
      )}
      {overlay === "shortcuts" && <ShortcutsDialog onClose={() => setOverlay(null)} />}

      {pending && (
        <ConfirmDialog
          title={t("shell.closeDirty.title", { title: pendingTitle })}
          // Ohne Speicher-Handler (Tab kann nicht selbst speichern) bleibt nur Verwerfen oder Abbrechen.
          danger={!tabs.canSave(pending.id)}
          confirmLabel={
            tabs.canSave(pending.id) ? t("shell.closeDirty.save") : t("shell.closeDirty.discard")
          }
          confirmIcon={tabs.canSave(pending.id) ? "save" : "trash"}
          onConfirm={() => void tabs.confirmClose(tabs.canSave(pending.id) ? "save" : "discard")}
          onCancel={tabs.cancelClose}
          extra={
            tabs.canSave(pending.id) ? (
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
            {t("shell.closeDirty.alertText", { title: pendingTitle })}
          </Message>
          {tabs.canSave(pending.id) && <span className="muted">{t("shell.closeDirty.hint")}</span>}
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
  return (
    <TabsProvider modules={modules}>
      <Frame />
    </TabsProvider>
  );
}
