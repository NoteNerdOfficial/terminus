import { describe, it } from "node:test";
import assert from "node:assert";
import { tidySeparators, typeaheadMatch, type MenuEntry } from "../src/views/menuModel";

const item = (name: string): MenuEntry<string> => ({ kind: "item", item: name });
const rule: MenuEntry<string> = { kind: "separator" };
const shape = (entries: Array<MenuEntry<string>>) => entries.map((e) => (e.kind === "item" ? e.item : "—")).join(" ");

/**
 * Menus are built from optional sections, each starting with a separator
 * (a terminal's row menu adds Fork and Send only for a Claude session), so
 * the separators that survive have to be the ones between items.
 */
describe("menu separators", () => {
  it("keeps one between two sections", () => {
    assert.strictEqual(shape(tidySeparators([item("New"), rule, item("Fork")])), "New — Fork");
  });

  it("drops one that opens or closes the menu", () => {
    assert.strictEqual(shape(tidySeparators([rule, item("Move"), rule])), "Move");
  });

  it("collapses a run left by a section that added nothing", () => {
    assert.strictEqual(shape(tidySeparators([item("Rename"), rule, rule, rule, item("Close")])), "Rename — Close");
  });

  it("leaves a menu of nothing but separators empty", () => {
    assert.deepStrictEqual(tidySeparators([rule, rule]), []);
  });
});

/** Typing letters in an open menu jumps to an item, as in a native one. */
describe("menu typeahead", () => {
  const titles = ["Rename", "Set folder…", "Colour…", "Snooze…", "Settle", "Close group"];

  it("jumps to the first item starting with a letter", () => {
    assert.strictEqual(typeaheadMatch(titles, -1, "c"), 2);
  });

  it("cycles through items with the same letter when it's typed again", () => {
    assert.strictEqual(typeaheadMatch(titles, 2, "c"), 5);
    assert.strictEqual(typeaheadMatch(titles, 5, "c"), 2);
  });

  it("narrows with each letter typed, staying put while the item still matches", () => {
    assert.strictEqual(typeaheadMatch(titles, 1, "se"), 1);
    assert.strictEqual(typeaheadMatch(titles, 1, "set"), 1);
    assert.strictEqual(typeaheadMatch(titles, 1, "sett"), 4);
  });

  it("ignores case", () => {
    assert.strictEqual(typeaheadMatch(titles, -1, "SN"), 3);
  });

  it("skips a disabled item", () => {
    // Settle is disabled (null), so "s" goes past it to Snooze.
    assert.strictEqual(typeaheadMatch([null, "Rename", "Snooze…"], -1, "s"), 2);
  });

  it("finds nothing for letters no item starts with", () => {
    assert.strictEqual(typeaheadMatch(titles, 0, "x"), -1);
  });
});
