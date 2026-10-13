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
  /** Folders folded in a long change list, by "token|agent|folder". */
  readonly collapsedFolders = new Set<string>();
  /** A card to bring into view on the next render: set by the sidebar's
   *  "to review" counts, consumed by the inbox. */
  revealToken: string | null = null;
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
