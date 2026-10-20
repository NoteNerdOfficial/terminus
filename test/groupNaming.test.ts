import { describe, it } from "node:test";
import assert from "node:assert";
import { titleFromPrompt } from "../src/groups/groupNaming";

/**
 * Titles made from a prompt. These name terminal groups and, since the
 * session log started recording a goal, a column in the Bases view -- which
 * is where a half-finished title shows up as obviously wrong, a page of them
 * ending in "and".
 */
describe("titles from a prompt", () => {
  it("never ends on the word that was about to introduce the rest", () => {
    const cases = [
      "Go through the getting-started guide and split the setup steps out into their own note.",
      "Refresh the glossary and the checklist, and have a subagent draft the next-steps page.",
      "Now regenerate the changelog and the FAQ, and run prettier over the reference notes.",
      "Rewrite every note in Guide/ to use the new terminology and then check the links in",
    ];
    for (const prompt of cases) {
      const title = titleFromPrompt(prompt)!;
      assert.ok(title, prompt);
      assert.ok(!/[\s,;:.!?-]$/.test(title), `no trailing punctuation: ${title}`);
      assert.ok(!/\s(and|or|but|with|for|to|in|on|of|the|a|an)$/i.test(title), `no dangling word: ${title}`);
    }
  });

  it("still keeps the words that carry the meaning", () => {
    assert.equal(titleFromPrompt("Could you please rewrite the pricing page?"), "Rewrite pricing page");
    assert.equal(titleFromPrompt("Refresh the glossary and the checklist, and have a subagent draft it."), "Refresh glossary and checklist");
  });

  it("declines to name a slash command", () => {
    assert.equal(titleFromPrompt("/compact"), null);
    assert.equal(titleFromPrompt("   "), null);
  });
});
