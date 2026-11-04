// Werte, die test/global-setup.ts (aus packages/db) bereitstellt.
import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    adminUrl: string;
    templateDb: string;
    appPassword: string;
  }
}
