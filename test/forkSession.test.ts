import { describe, it } from "node:test";
import assert from "node:assert";
import { forkCommand } from "../src/groups/forkSession";

/**
 * The fork command is typed into a shell, so the session id in it comes
 * only from something shaped like the UUIDs Claude Code issues.
 */
describe("the fork command", () => {
  it("is only built from an id shaped like Claude Code's", () => {
    assert.strictEqual(
      forkCommand("0f8fad5b-d9cb-469f-a165-70867728950e"),
      "claude --resume 0f8fad5b-d9cb-469f-a165-70867728950e --fork-session"
    );
    assert.strictEqual(forkCommand("abc; rm -rf ~"), null);
    assert.strictEqual(forkCommand(null), null);
  });
});
