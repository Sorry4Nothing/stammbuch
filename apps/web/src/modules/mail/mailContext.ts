import { createContext, useContext } from "react";
import { createHttpMailService } from "./httpMailService";
import type { MailService } from "./mailService";

/** Standard ist die API; Tests und Entwicklung setzen `memoryMailService` ein. */
export const MailServiceContext = createContext<MailService>(createHttpMailService());

export const useMailService = () => useContext(MailServiceContext);
