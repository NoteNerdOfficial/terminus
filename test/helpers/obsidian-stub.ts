/**
 * The slice of Obsidian's API the plugin modules under test actually reach.
 *
 * Only what is needed to load and exercise them: TFile and TFolder exist as
 * real classes because the code under test uses `instanceof` on them, so a
 * plain object would not do. Everything else a test needs is injected as a
 * fake plugin (see fakeVault.ts) rather than stubbed here.
 */
export class TFile {
  path = "";
  extension = "md";
}

export class TFolder {
  path = "";
  children: unknown[] = [];
}

export class Notice {
  constructor(public message: string) {}
}

export function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
