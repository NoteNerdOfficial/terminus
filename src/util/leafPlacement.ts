import type { Workspace, WorkspaceLeaf } from "obsidian";
import type { TerminalPlacement } from "../settings";

/** Where a new terminal opens, once any "Always ask" has been answered. */
export type OpenPlacement = Exclude<TerminalPlacement, "ask">;

/** A new leaf for a terminal, placed as asked. A split is made off the
 *  most recent leaf explicitly, rather than trusting `getLeaf("split",
 *  direction)` to pick the right one internally (it's just
 *  `createLeafBySplit(getMostRecentLeaf(), direction)` under the hood):
 *  going through it directly had the exact same "split down" opening to the
 *  side instead of below bug in the Tab Spaces plugin. */
export function leafForPlacement(workspace: Workspace, placement: OpenPlacement): WorkspaceLeaf {
  switch (placement) {
    case "split-right":
    case "split-down": {
      const anchor = workspace.getMostRecentLeaf();
      const direction = placement === "split-right" ? "vertical" : "horizontal";
      return anchor ? workspace.createLeafBySplit(anchor, direction) : workspace.getLeaf("split", direction);
    }
    case "window":
      return workspace.getLeaf("window");
    case "tab":
    default:
      return workspace.getLeaf("tab");
  }
}
