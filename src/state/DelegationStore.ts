import { TypedEmitter } from "../node/emitter";

/** A task the user sent from one terminal's session to a new terminal. */
export interface Delegation {
  /** The new terminal's hook token. */
  childToken: string;
  /** The terminal it was sent from, whose card shows the result. */
  parentToken: string;
  /** The task as typed, kept for the card (the child's own prompt is what
   *  Claude saw). */
  task: string;
  /** Names when it was sent, for a terminal that has since closed. */
  parentLabel: string;
  childLabel: string;
  createdAt: number;
}

type DelegationStoreEvents = {
  change: [];
};

/**
 * Tasks sent to new terminals, in memory (a terminal's token doesn't
 * outlive Obsidian either). The Agent inbox lists them on the sending
 * session's card, with the new session's result once its turn ends.
 */
export class DelegationStore extends TypedEmitter<DelegationStoreEvents> {
  private items: Delegation[] = [];

  add(delegation: Delegation): void {
    this.items.push(delegation);
    this.emit("change");
  }

  get(childToken: string): Delegation | undefined {
    return this.items.find((d) => d.childToken === childToken);
  }

  forParent(parentToken: string): Delegation[] {
    return this.items.filter((d) => d.parentToken === parentToken);
  }

  /** Dismissed, or its result sent back. */
  remove(childToken: string): void {
    const before = this.items.length;
    this.items = this.items.filter((d) => d.childToken !== childToken);
    if (this.items.length !== before) this.emit("change");
  }
}
