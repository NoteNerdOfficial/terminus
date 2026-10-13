import { WorkspaceLeaf } from "obsidian";
import { TerminalView } from "../views/TerminalView";
import { DiffSplitView } from "../views/DiffSplitView";
import type TerminusPlugin from "../main";

/** Leaf internals used here; none are in Obsidian's public typings. Every
 *  reach is feature-detected, so a changed shape means tabs simply stay
 *  visible. */
interface LeafInternals {
  id?: string;
  tabHeaderEl?: HTMLElement;
  parent?: TabsInternals;
}

interface TabsInternals {
  containerEl?: HTMLElement;
  children?: WorkspaceLeaf[];
  currentTab?: number;
  selectTab?: (leaf: WorkspaceLeaf) => void;
  selectTabIndex?: (index: number) => void;
}

const HIDDEN_TAB = "terminus-hidden-tab";
const HIDDEN_PANE = "terminus-hidden-pane";

/**
 * Shows only the selected group's tabs (plus ungrouped terminals and every
 * tab that isn't in a group) in the editor area, the way selecting a
 * workspace does in cmux. Other groups' tabs are hidden, not closed, so
 * their shells and Claude sessions keep running.
 *
 * Hiding is per tab: a class on the tab header. A pane whose tabs are all
 * hidden collapses through CSS (`:has()`, as Working tabs does for panes),
 * and a pane showing a tab that's now hidden switches to a visible one.
 * Applied on events only (group selected, a terminal moved, a tab added to
 * a group, the layout changing); never on a timer, and never by reading a
 * terminal's view state.
 */
export class TabVisibility {
  constructor(private readonly plugin: TerminusPlugin) {}

  /** The group a tab belongs to, or null for a tab shown in every group. */
  groupOf(leaf: WorkspaceLeaf): string | null {
    const store = this.plugin.groupStore;
    const view = leaf.view;
    if (view instanceof TerminalView) return store.get(view.groupId) ? view.groupId : null;
    // Split Diff belongs to the group whose session made the change it shows.
    if (view instanceof DiffSplitView) {
      const owner = view.shownChangeOwner();
      const terminal = owner ? this.plugin.findTerminalView(owner) : null;
      if (terminal?.groupId && store.get(terminal.groupId)) return terminal.groupId;
    }
    const id = (leaf as LeafInternals).id;
    return id ? (store.tabGroup(id) ?? null) : null;
  }

  apply(): void {
    const enabled = this.plugin.experience === "multi-agent";
    const active = this.plugin.groupStore.activeGroupId;
    const panes = new Set<TabsInternals>();

    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!this.inEditorArea(leaf)) return;
      const group = enabled ? this.groupOf(leaf) : null;
      const hidden = group !== null && group !== active;
      (leaf as LeafInternals).tabHeaderEl?.toggleClass(HIDDEN_TAB, hidden);
      const parent = (leaf as LeafInternals).parent;
      if (parent) panes.add(parent);
    });

    for (const pane of panes) this.applyToPane(pane);
  }

  /** A tab is hidden when its header carries the class (set by apply). */
  isHidden(leaf: WorkspaceLeaf): boolean {
    return (leaf as LeafInternals).tabHeaderEl?.hasClass(HIDDEN_TAB) ?? false;
  }

  /** Collapses a pane with nothing visible, and moves a pane off a tab that
   *  just got hidden onto one that's showing. */
  private applyToPane(pane: TabsInternals): void {
    const children = pane.children ?? [];
    const visible = children.filter((leaf) => !this.isHidden(leaf));
    pane.containerEl?.toggleClass(HIDDEN_PANE, children.length > 0 && visible.length === 0);
    const current = typeof pane.currentTab === "number" ? children[pane.currentTab] : undefined;
    const next = visible[0];
    if (!current || !this.isHidden(current) || !next) return;
    if (pane.selectTab) pane.selectTab(next);
    else if (pane.selectTabIndex) pane.selectTabIndex(children.indexOf(next));
  }

  /** The editor area and pop-out windows, not the sidebars. */
  private inEditorArea(leaf: WorkspaceLeaf): boolean {
    const { workspace } = this.plugin.app;
    const root = leaf.getRoot();
    return root !== workspace.leftSplit && root !== workspace.rightSplit;
  }

  /** How many terminals are in groups other than the selected one, for the
   *  status bar's "N in other groups". */
  hiddenTerminalCount(): number {
    const active = this.plugin.groupStore.activeGroupId;
    return this.plugin.groups.terminals().filter((t) => t.groupId && this.plugin.groupStore.get(t.groupId) && t.groupId !== active).length;
  }
}
