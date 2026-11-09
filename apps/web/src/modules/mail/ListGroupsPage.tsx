import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useCurrentTab, useTabs } from "../../shell/tabs";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Message,
  PageHeader,
  Panel,
  TextField,
  useToast,
  type Column,
} from "../../ui";
import { useMailService } from "./mailContext";
import type { AddressListDetail, MailGroup } from "./mailService";
import { ActionError, Loading, LoadError, MailLayout, useCloseWhen, useTabDirty } from "./parts";
import { useLoad } from "./useMail";

const number = (n: number | null) => (n === null ? "–" : String(n));

function Editor({ detail, groups }: { detail: AddressListDetail | null; groups: MailGroup[] }) {
  const service = useMailService();
  const toast = useToast();
  const tab = useCurrentTab();
  const { openTab } = useTabs();
  const [name, setName] = useState(detail?.name ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(detail?.groupIds ?? []));
  const [nameError, setNameError] = useState<string>();
  const [actionError, setActionError] = useState<unknown>();
  const [groupError, setGroupError] = useState(false);
  const [done, setDone] = useState(false);

  const snapshot = JSON.stringify([name, [...selected].sort()]);
  const [saved, setSaved] = useState(snapshot);
  useTabDirty(!done && snapshot !== saved);
  useCloseWhen(done);
  useEffect(() => tab.setTitle(name.trim() || t("mail.listGroups.tab")), [tab, name]);

  const chosen = groups.filter((g) => selected.has(g.id));
  const persons = chosen.reduce((n, g) => n + g.persons, 0);
  const known = chosen.every((g) => g.withoutEmail !== null);
  const without = chosen.reduce((n, g) => n + (g.withoutEmail ?? 0), 0);

  const save = async (): Promise<boolean> => {
    setActionError(undefined);
    const noName = name.trim() === "";
    setNameError(noName ? t("mail.listEdit.error.name") : undefined);
    setGroupError(selected.size === 0);
    if (noName || selected.size === 0) return false;
    try {
      await service.saveList({
        ...(detail ? { id: detail.id } : {}),
        name: name.trim(),
        description: detail?.description ?? "",
        entries: detail?.entries ?? [],
        groupIds: [...selected],
      });
      toast.show({ tone: "ok", title: t("mail.listEdit.saved") });
      setSaved(snapshot);
      return true;
    } catch (e) {
      setActionError(e);
      return false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => tab.registerSave(() => saveRef.current()), [tab]);

  const finish = async () => {
    if (await save()) {
      setDone(true);
      openTab("mail-lists", { key: "mail-lists" });
    }
  };

  const columns: Column<MailGroup>[] = [
    { key: "name", header: t("mail.groups.col.group"), cell: (g) => <b>{g.name}</b> },
    {
      key: "persons",
      header: t("mail.groups.col.persons"),
      width: "118px",
      align: "right",
      cell: (g) => g.persons,
    },
    {
      key: "without",
      header: t("mail.groups.col.withoutEmail"),
      width: "129px",
      align: "right",
      cell: (g) => number(g.withoutEmail),
    },
    {
      key: "with",
      header: t("mail.groups.col.withEmail"),
      width: "129px",
      align: "right",
      cell: (g) => number(g.withoutEmail === null ? null : g.persons - g.withoutEmail),
    },
  ];

  return (
    <>
      <PageHeader
        crumb={t("mail.crumb.listGroups", { name: detail?.name ?? t("mail.listGroups.new") })}
        title={detail?.name ?? t("mail.listGroups.title")}
        status={<Badge tone="neutral">{t("mail.lists.type.groups")}</Badge>}
        actions={
          <>
            <Button icon="close" onClick={() => setDone(true)}>
              {t("ui.cancel")}
            </Button>
            <Button variant="primary" icon="save" onClick={() => void finish()}>
              {t("mail.listEdit.save")}
            </Button>
          </>
        }
      />
      {actionError !== undefined && <ActionError error={actionError} />}
      <div className="mail-cols">
        <div className="mail-cols__main mail-form">
          <TextField
            label={t("mail.listGroups.name")}
            required
            value={name}
            error={nameError}
            autoComplete="off"
            className="mail-name"
            onChange={(e) => setName(e.target.value)}
          />
          {groupError && <Message tone="error">{t("mail.listGroups.error.groups")}</Message>}
          <Panel
            title={t("mail.listGroups.choose", { n: selected.size, total: groups.length })}
            flush
          >
            <DataTable
              label={t("mail.listGroups.table")}
              columns={columns}
              rows={groups}
              rowKey={(g) => g.id}
              selectable
              selected={selected}
              onSelectedChange={(s) => {
                setSelected(s);
                setGroupError(false);
              }}
              empty={
                <EmptyState
                  icon="people"
                  title={t("mail.groups.empty.title")}
                  text={t("mail.groups.empty.text")}
                />
              }
            />
          </Panel>
        </div>
        <div className="mail-side mail-side--wide">
          <Panel title={t("mail.listGroups.result")}>
            <dl className="kv mail__kv mail__kv--wide">
              <dt>{t("mail.listGroups.chosen")}</dt>
              <dd>{chosen.length}</dd>
              <dt>{t("mail.bulk.persons")}</dt>
              <dd>{persons}</dd>
              <dt>{t("mail.bulk.noEmail")}</dt>
              <dd>{known ? without : "–"}</dd>
              <dt>{t("mail.bulk.recipientCount")}</dt>
              <dd>
                <b>{known ? persons - without : "–"}</b>
              </dd>
            </dl>
          </Panel>
          <Message tone="ok" title={t("mail.listGroups.noDup.title")}>
            {t("mail.listGroups.noDup.text")}
          </Message>
          <Message tone="neutral" title={t("mail.listGroups.live.title")}>
            {t("mail.listGroups.live.text")}
          </Message>
        </div>
      </div>
    </>
  );
}

/** Adressliste aus Gruppen erstellen (Design 7.10). Mit `listId` wird eine bestehende Liste bearbeitet. */
export function ListGroupsPage() {
  const service = useMailService();
  const tab = useCurrentTab();
  const id = tab.params["listId"];
  const [load, reload] = useLoad(
    async (signal) => {
      const [groups, detail] = await Promise.all([
        service.groups(signal),
        id ? service.list(id, signal) : Promise.resolve(null),
      ]);
      return { groups, detail };
    },
    [service, id],
  );
  return (
    <MailLayout current="lists">
      {load.status === "loading" && <Loading />}
      {load.status === "error" && <LoadError load={load} onRetry={reload} />}
      {load.status === "ready" && <Editor detail={load.data.detail} groups={load.data.groups} />}
    </MailLayout>
  );
}
