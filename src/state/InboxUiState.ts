/**
 * What the Agent inbox remembers about how the user has arranged it: which
 * cards are folded, which finished ones were dismissed, whether it shows the
 * selected group or everything. Owned by the plugin rather than the view, so
 * closing and reopening the inbox doesn't reset it.
 *
 * `userActionRevision` counts the user's own choices in the inbox. An
 * automatic reveal reads it when a burst of edits begins and is refused if it
 * moved before the reveal fires: the user closed or rearranged the panel in
 * the meantime, and the plugin shouldn't override that.
 */
export class InboxUiState {
  /** Cards folded to their header, by terminal token. */
  readonly collapsedCards = new Set<string>();
  /** Finished cards dismissed (by token) until their session's next turn. */
  readonly dismissed = new Set<string>();
  /** Cards whose "nothing to review" agents are unfolded. */
  readonly expandedQuiet = new Set<string>();
  /** Folders folded in a long change list, by "token|scope|agent|folder". */
  readonly collapsedFolders = new Set<string>();
  /** Turn sections folded on a card, by "token|promptId". Only cards whose
   *  pending changes span more than one turn have them. */
  readonly collapsedTurns = new Set<string>();
  /** Cards whose "changed outside Claude's edit tools" list is unfolded. */
  readonly expandedShellChanges = new Set<string>();
  /** A card to bring into view on the next render: set by the sidebar's
   *  "to review" counts, consumed by the inbox. */
  revealToken: string | null = null;
  /** What's typed in each session's "Tell this session…" box, by token, so a
   *  re-render (or a fold) doesn't lose it. */
  readonly drafts = new Map<string, string>();
  /** Cards whose "Tell this session…" box was opened with Reply. A working
   *  card's box is always open and a drafted one stays open, so this only
   *  matters for a card between turns; an empty box closes on blur. */
  readonly openComposers = new Set<string>();
  /** A card whose box to focus on the next render: set when Reply opens it. */
  focusComposer: string | null = null;
  /** The tokens the last dismissal hid, for Undo. */
  lastDismissed: string[] = [];
  finishedCollapsed = false;
  elsewhereCollapsed = false;
  /** False: the inbox follows the sidebar's selected group. True: every session. */
  showAll = false;

  private revision = 0;

  get userActionRevision(): number {
    return this.revision;
  }

  /** Call from every handler that is the user rearranging the inbox. */
  userAction(): void {
    this.revision++;
  }
}
