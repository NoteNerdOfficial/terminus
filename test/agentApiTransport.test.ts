import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { ReviewServer } from "../src/server/ReviewServer";

/**
 * The agent API's transport, end to end: the real Python client in
 * resources/ against the real review server, with the handler replaced by
 * one that echoes what reached it. What AgentApi then does with a request
 * needs Obsidian; that the CLI's subcommands become the right methods and
 * params, and that errors come back as exit status and JSON, doesn't.
 */

const CLI = join(__dirname, "..", "..", "resources", "terminus_cli.py");
const TOKEN = "test-token";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("agent API transport", { skip: !hasPython() && "python3 not available" }, () => {
  const server = new ReviewServer();
  let port = 0;
  const seen: unknown[] = [];

  before(async () => {
    port = await server.start();
    server.register(TOKEN, {
      onChangeApplied: async () => {},
      onShellCommand: async () => {},
      onTurnEnd: () => {},
      onNeedsAttention: () => {},
      onSessionEvent: () => {},
    });
    server.setApiHandler(async (token, request) => {
      seen.push(request);
      const { method } = request as { method: string };
      if (method === "terminal.close") return { status: 403, body: { ok: false, error: { code: "forbidden", message: "not yours" } } };
      if (method === "terminal.read") return { status: 200, body: { ok: true, result: { id: "t2", text: "line one\nline two" } } };
      return { status: 200, body: { ok: true, result: { token, request } } };
    });
  });

  after(async () => {
    await server.stop();
  });

  /** Asynchronously: the server answering it runs in this same process. */
  function run(args: string[], env: Record<string, string | undefined>): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile("python3", ["-I", CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }, (err, stdout, stderr) => {
        const status = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ status, stdout, stderr });
      });
    });
  }

  function cli(args: string[], token = TOKEN) {
    return run(args, { TERMINUS_HOOK_PORT: String(port), TERMINUS_HOOK_TOKEN: token });
  }

  it("turns a subcommand into its method and params, dropping unset options", async () => {
    const { status, stdout } = await cli(["open", "--name", "server", "--command", "npm run dev", "--placement", "split-right"]);
    assert.equal(status, 0);
    const result = JSON.parse(stdout) as { token: string; request: unknown };
    assert.equal(result.token, TOKEN);
    assert.deepEqual(result.request, { method: "terminal.open", params: { name: "server", command: "npm run dev", placement: "split-right" } });
  });

  it("sends prompts queued unless --now, and waits in milliseconds", async () => {
    const queued = JSON.parse((await cli(["prompt", "t4", "hello"])).stdout) as { request: unknown };
    assert.deepEqual(queued.request, { method: "agent.prompt", params: { id: "t4", text: "hello", mode: "queue" } });
    const steered = JSON.parse((await cli(["prompt", "t4", "hello", "--now"])).stdout) as { request: { params: { mode: string } } };
    assert.equal(steered.request.params.mode, "steer");
    const wait = JSON.parse((await cli(["wait", "t4", "--next-turn", "--timeout", "30", "--until", "done"])).stdout) as { request: unknown };
    assert.deepEqual(wait.request, { method: "agent.wait", params: { id: "t4", until: ["done"], next_turn: true, timeout_ms: 30000 } });
  });

  it("prints read's text as text", async () => {
    const { status, stdout } = await cli(["read", "t2"]);
    assert.equal(status, 0);
    assert.equal(stdout, "line one\nline two\n");
  });

  it("reports an API error on stderr with exit status 1", async () => {
    const { status, stdout, stderr } = await cli(["close", "t2"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.deepEqual(JSON.parse(stderr), { error: { code: "forbidden", message: "not yours" } });
  });

  it("refuses a token no terminal registered", async () => {
    const { status, stderr } = await cli(["whoami"], "someone-else");
    assert.equal(status, 1);
    assert.match(stderr, /http_403/);
  });

  it("explains itself outside a Terminus terminal", async () => {
    const result = await run(["whoami"], {});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not_in_terminus/);
  });

  it("rejects a body that isn't JSON", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: "not json",
    });
    assert.equal(response.status, 400);
    assert.equal(seen.length > 0, true);
  });
});
