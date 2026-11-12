import { describe, it } from "node:test";
import assert from "node:assert";
import { formatSnapshot, parseAxTree } from "../src/browser/snapshot";
import { parseKey } from "../src/browser/keys";

/** A node in the shape Chrome's Accessibility.getFullAXTree sends. */
function ax(
  nodeId: string,
  role: string,
  name: string,
  childIds: string[] = [],
  extra: { parentId?: string; backend?: number; value?: string; ignored?: boolean; properties?: Record<string, unknown> } = {}
): Record<string, unknown> {
  return {
    nodeId,
    ignored: extra.ignored ?? false,
    role: { type: "role", value: role },
    name: { type: "computedString", value: name },
    ...(extra.value !== undefined ? { value: { type: "string", value: extra.value } } : {}),
    properties: Object.entries(extra.properties ?? {}).map(([n, v]) => ({ name: n, value: { type: "x", value: v } })),
    childIds,
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
    ...(extra.backend !== undefined ? { backendDOMNodeId: extra.backend } : {}),
  };
}

const PAGE = {
  nodes: [
    ax("1", "RootWebArea", "Pricing", ["2"], { backend: 1 }),
    ax("2", "generic", "", ["3", "5", "7", "9", "11", "12"], { parentId: "1", backend: 2 }),
    ax("3", "heading", "Pricing", ["4"], { parentId: "2", backend: 3, properties: { level: 1 } }),
    ax("4", "StaticText", "Pricing", [], { parentId: "3", backend: 4 }),
    ax("5", "button", "Subscribe", ["6"], { parentId: "2", backend: 5, properties: { disabled: true } }),
    ax("6", "StaticText", "Subscribe", [], { parentId: "5", backend: 6 }),
    ax("7", "textbox", "Email", ["8"], { parentId: "2", backend: 7, value: "ada@example.com", properties: { focused: true } }),
    ax("8", "StaticText", "ada@example.com", [], { parentId: "7", backend: 8 }),
    ax("9", "checkbox", "Yearly", [], { parentId: "2", backend: 9, properties: { checked: "true" } }),
    ax("11", "paragraph", "", ["13"], { parentId: "2", backend: 11 }),
    ax("13", "StaticText", "Cancel any time.", [], { parentId: "11", backend: 13 }),
    ax("12", "link", "Back", [], { parentId: "2", backend: 12, ignored: true }),
  ],
};

describe("page snapshot", () => {
  it("shows elements with refs, states and values, and text on its own", () => {
    const snapshot = formatSnapshot(parseAxTree(PAGE));
    assert.equal(
      snapshot.text,
      [
        '- heading "Pricing" [level=1] [ref=e1]',
        '- button "Subscribe" [disabled] [ref=e2]',
        '- textbox "Email" [focused] [ref=e3]: ada@example.com',
        '- checkbox "Yearly" [checked] [ref=e4]',
        "- paragraph [ref=e5]",
        "  - text: Cancel any time.",
      ].join("\n")
    );
    assert.deepEqual([...snapshot.refs], [["e1", 3], ["e2", 5], ["e3", 7], ["e4", 9], ["e5", 11]]);
    assert.equal(snapshot.truncated, false);
  });

  it("nests children under their element", () => {
    const tree = {
      nodes: [
        ax("1", "RootWebArea", "", ["2"]),
        ax("2", "list", "", ["3"], { parentId: "1", backend: 2 }),
        ax("3", "listitem", "", ["4"], { parentId: "2", backend: 3 }),
        ax("4", "link", "Docs", [], { parentId: "3", backend: 4 }),
      ],
    };
    assert.equal(formatSnapshot(parseAxTree(tree)).text, ["- list [ref=e1]", "  - listitem [ref=e2]", '    - link "Docs" [ref=e3]'].join("\n"));
  });

  it("quotes names safely and stops at the line limit", () => {
    const many = { nodes: [ax("r", "RootWebArea", "", ["a", "b", "c"]), ...["a", "b", "c"].map((id, i) => ax(id, "button", `Say "hi" ${i}`, [], { parentId: "r", backend: i + 10 }))] };
    const snapshot = formatSnapshot(parseAxTree(many), 2);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.text.split("\n"), ['- button "Say \\"hi\\" 0" [ref=e1]', '- button "Say \\"hi\\" 1" [ref=e2]', "- … 1 more lines not shown"]);
    assert.equal(snapshot.refs.size, 2);
  });

  it("skips malformed nodes and refuses a result with no tree", () => {
    assert.throws(() => parseAxTree({}), /no accessibility tree/);
    assert.equal(parseAxTree({ nodes: [null, 3, { role: "x" }, ax("1", "button", "Ok")] }).length, 1);
  });
});

describe("key names", () => {
  it("knows named keys and what they type", () => {
    assert.deepEqual(parseKey("Enter"), { electronKey: "Enter", text: "\r", modifiers: [] });
    assert.deepEqual(parseKey("tab"), { electronKey: "Tab", text: "", modifiers: [] });
    assert.equal(parseKey("ArrowDown").electronKey, "Down");
    assert.equal(parseKey("F5").electronKey, "F5");
    assert.deepEqual(parseKey("Space"), { electronKey: "Space", text: " ", modifiers: [] });
  });

  it("types single characters, shifted when asked", () => {
    assert.deepEqual(parseKey("a"), { electronKey: "a", text: "a", modifiers: [] });
    assert.deepEqual(parseKey("Shift+a"), { electronKey: "A", text: "A", modifiers: ["shift"] });
    assert.deepEqual(parseKey("7"), { electronKey: "7", text: "7", modifiers: [] });
    assert.deepEqual(parseKey("+"), { electronKey: "Plus", text: "+", modifiers: [] });
    assert.deepEqual(parseKey("Shift++"), { electronKey: "Plus", text: "+", modifiers: ["shift"] });
  });

  it("makes shortcuts that type nothing", () => {
    assert.deepEqual(parseKey("Control+a"), { electronKey: "a", text: "", modifiers: ["control"] });
    assert.deepEqual(parseKey("Cmd+Shift+z").modifiers, ["meta", "shift"]);
    assert.deepEqual(parseKey("Shift+Tab"), { electronKey: "Tab", text: "", modifiers: ["shift"] });
    assert.equal(parseKey("Control+Enter").text, "");
  });

  it("names what it doesn't understand", () => {
    assert.throws(() => parseKey(""), /No key/);
    assert.throws(() => parseKey("Hyper+a"), /Unknown modifier "Hyper"/);
    assert.throws(() => parseKey("Enterr"), /Unknown key "Enterr"/);
  });
});
