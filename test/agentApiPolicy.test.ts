import { describe, it } from "node:test";
import assert from "node:assert";
import { ApiError, RateLimiter, bypassFlagIn, findMatchingLine, optionalChoice, optionalInt, publicStatus, requireString, tailLines } from "../src/agentApi/policy";
import type { AgentSession } from "../src/state/AgentSessionStore";

function session(fields: Partial<AgentSession>): AgentSession {
  return { running: true, status: "idle", needs: null, ...fields } as AgentSession;
}

describe("permission-bypass refusal", () => {
  it("finds the bypass flags wherever they are on the line", () => {
    assert.equal(bypassFlagIn("claude --dangerously-skip-permissions"), "--dangerously-skip-permissions");
    assert.equal(bypassFlagIn("env FOO=1 claude --allow-dangerously-skip-permissions -p hi"), "--allow-dangerously-skip-permissions");
    assert.ok(bypassFlagIn("claude --permission-mode bypassPermissions"));
    assert.ok(bypassFlagIn("claude --permission-mode=bypassPermissions"));
    assert.ok(bypassFlagIn("claude --permission-mode 'bypassPermissions'"));
  });

  it("lets ordinary commands through", () => {
    assert.equal(bypassFlagIn("claude"), null);
    assert.equal(bypassFlagIn("claude --permission-mode acceptEdits"), null);
    assert.equal(bypassFlagIn("npm run dev"), null);
  });
});

describe("rate limiter", () => {
  it("allows the limit within the window, then refuses until it slides", () => {
    const limiter = new RateLimiter(2, 1000);
    assert.equal(limiter.take("a", 0), true);
    assert.equal(limiter.take("a", 100), true);
    assert.equal(limiter.take("a", 200), false);
    assert.equal(limiter.take("b", 200), true);
    assert.equal(limiter.take("a", 1050), true);
  });
});

describe("public status", () => {
  it("maps the store's states to the API's", () => {
    assert.equal(publicStatus(undefined), "none");
    assert.equal(publicStatus(session({ running: false })), "ended");
    assert.equal(publicStatus(session({ status: "working" })), "working");
    assert.equal(publicStatus(session({ status: "needs-attention", needs: "permission" })), "blocked");
    assert.equal(publicStatus(session({ status: "needs-attention", needs: "unread-turn" })), "done");
    assert.equal(publicStatus(session({ status: "finished-unread" })), "done");
    assert.equal(publicStatus(session({ status: "idle" })), "idle");
  });
});

describe("terminal output", () => {
  it("drops the blank rows below the cursor before taking the tail", () => {
    assert.deepEqual(tailLines(["a", "b", "c", "", "  "], 2), ["b", "c"]);
    assert.deepEqual(tailLines(["a"], 5), ["a"]);
  });

  it("matches a substring or a regular expression", () => {
    const lines = ["starting", "Local: http://localhost:5173", "ready in 300 ms"];
    assert.equal(findMatchingLine(lines, "ready in", false), "ready in 300 ms");
    assert.equal(findMatchingLine(lines, "localhost:\\d+", true), "Local: http://localhost:5173");
    assert.equal(findMatchingLine(lines, "error", false), null);
  });

  it("reports an invalid expression as a parameter error", () => {
    assert.throws(() => findMatchingLine([], "(", true), (err) => err instanceof ApiError && err.code === "invalid_params");
  });
});

describe("parameters", () => {
  it("requires non-empty strings and bounds their length", () => {
    assert.equal(requireString({ id: "t1" }, "id"), "t1");
    assert.throws(() => requireString({}, "id"), ApiError);
    assert.throws(() => requireString({ id: "  " }, "id"), ApiError);
    assert.throws(() => requireString({ id: "x".repeat(30) }, "id", 20), ApiError);
  });

  it("clamps numbers and checks choices", () => {
    assert.equal(optionalInt({}, "n", 80, 1, 100), 80);
    assert.equal(optionalInt({ n: 1000 }, "n", 80, 1, 100), 100);
    assert.throws(() => optionalInt({ n: "5" }, "n", 80, 1, 100), ApiError);
    assert.equal(optionalChoice({}, "p", ["tab", "split-right"] as const, "tab"), "tab");
    assert.throws(() => optionalChoice({ p: "window" }, "p", ["tab", "split-right"] as const, "tab"), ApiError);
  });
});
