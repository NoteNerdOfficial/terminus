/**
 * What Classic's Pending Changes panel remembers about how the user has
 * arranged it. Owned by the plugin rather than the view, for the same reason
 * InboxUiState is: Obsidian rebuilds a sidebar view whenever it has been
 * deferred, so state held on the view itself is lost without warning -- and
 * the panel re-renders on every recorded edit, which is exactly when losing
 * it is most visible.
 */
export class ClassicUiState {
  /** Terminal groups folded to their header, by panel label. */
  readonly collapsedGroups = new Set<string>();
  /** Whether the "changed without a snapshot" list is unfolded. Folded by
   *  default: it is the footnote to the review list, not the list. */
  shellExpanded = false;
}
