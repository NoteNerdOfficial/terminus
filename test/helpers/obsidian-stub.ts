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

/**
 * Never constructed by a test: it exists so modules that sit beside a modal
 * can be imported for their pure helpers. modals/collisions.ts is the case
 * in point -- hasCollision, collisionLabel and diffBaselines are plain
 * functions over a PendingChange, but they share a file with
 * confirmCollisionReject, which extends this.
 */
export class Modal {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
}

export function normalizePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
