import type { ModuleDefinition } from "../types";
import { BulkPage } from "./BulkPage";
import { ComposePage } from "./ComposePage";
import { InboxPage } from "./InboxPage";
import { ListEditPage } from "./ListEditPage";
import { ListGroupsPage } from "./ListGroupsPage";
import { ListsPage } from "./ListsPage";
import { PlanPage } from "./PlanPage";
import { ReadPage } from "./ReadPage";
import { StatusPage } from "./StatusPage";

export const mailModule: ModuleDefinition = {
  id: "mail",
  titleKey: "module.mail.title",
  nav: { labelKey: "module.mail.nav", icon: "mail", order: 50, tabType: "mail" },
  newTabType: "mail-compose",
  tabTypes: [
    { id: "mail", titleKey: "mail.folder.inbox", component: InboxPage },
    { id: "mail-read", titleKey: "mail.tab.read", component: ReadPage },
    { id: "mail-compose", titleKey: "mail.compose.new", component: ComposePage },
    { id: "mail-bulk", titleKey: "mail.bulk.title", component: BulkPage },
    { id: "mail-lists", titleKey: "mail.lists.title", component: ListsPage },
    { id: "mail-list", titleKey: "mail.listEdit.new", component: ListEditPage },
    { id: "mail-list-groups", titleKey: "mail.listGroups.tab", component: ListGroupsPage },
    { id: "mail-plan", titleKey: "mail.plan.title", component: PlanPage },
    { id: "mail-status", titleKey: "mail.status.title", component: StatusPage },
  ],
};
