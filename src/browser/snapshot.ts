/**
 * Turns Chrome's accessibility tree (`Accessibility.getFullAXTree`) into the
 * text an agent reads: one line per element, indented by nesting, with a
 * ref (`e12`) for every element it can act on. Close to what Playwright MCP
 * shows, so an agent that knows one reads the other:
 *
 *   - heading "Pricing" [level=1] [ref=e2]
 *   - textbox "Email" [ref=e5]: ada@example.com
 *   - button "Subscribe" [disabled] [ref=e6]
 *
 * Pure: the protocol result goes in as untyped JSON and is checked here.
 */

export interface AxNode {
  nodeId: string;
  ignored: boolean;
  role: string;
  name: string;
  value: string;
  properties: Map<string, unknown>;
  childIds: string[];
  parentId: string | null;
  backendDOMNodeId: number | null;
}

export interface Snapshot {
  text: string;
  /** ref → the element's backendDOMNodeId. */
  refs: Map<string, number>;
  /** ref → its name in quotes (`"Save"`), or its role when it has none, for saying what an agent did. */
  labels: Map<string, string>;
  truncated: boolean;
}

/** Roles that only group other nodes: their children are shown in their place. */
const TRANSPARENT_ROLES = new Set(["none", "generic", "presentation", "InlineTextBox", "LineBreak", "RootWebArea", "WebArea", "ignored"]);
const TEXT_ROLES = new Set(["StaticText", "text"]);
/** Roles whose value is what the user typed or picked. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "TextField"]);
const MAX_NAME = 200;
const MAX_TEXT = 300;
export const MAX_SNAPSHOT_LINES = 1500;

function axString(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const inner = (value as { value?: unknown }).value;
  if (typeof inner === "string") return inner;
  if (typeof inner === "number" || typeof inner === "boolean") return String(inner);
  return "";
}

/** Reads the protocol's `{ nodes: [...] }`, skipping anything malformed. */
export function parseAxTree(result: unknown): AxNode[] {
  const nodes = (result as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) throw new Error("The page gave no accessibility tree");
  const out: AxNode[] = [];
  for (const raw of nodes as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const n = raw as Record<string, unknown>;
    if (typeof n.nodeId !== "string") continue;
    const properties = new Map<string, unknown>();
    if (Array.isArray(n.properties)) {
      for (const p of n.properties as unknown[]) {
        const prop = p as { name?: unknown; value?: { value?: unknown } } | null;
        if (prop && typeof prop.name === "string") properties.set(prop.name, prop.value?.value);
      }
    }
    out.push({
      nodeId: n.nodeId,
      ignored: n.ignored === true,
      role: axString(n.role),
      name: axString(n.name).replace(/\s+/g, " ").trim(),
      value: axString(n.value),
      properties,
      childIds: Array.isArray(n.childIds) ? (n.childIds as unknown[]).filter((c): c is string => typeof c === "string") : [],
      parentId: typeof n.parentId === "string" ? n.parentId : null,
      backendDOMNodeId: typeof n.backendDOMNodeId === "number" ? n.backendDOMNodeId : null,
    });
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attributes(node: AxNode): string {
  const parts: string[] = [];
  const p = node.properties;
  const checked = p.get("checked");
  if (checked === "true" || checked === true) parts.push("[checked]");
  else if (checked === "mixed") parts.push("[checked=mixed]");
  const pressed = p.get("pressed");
  if (pressed === "true" || pressed === true) parts.push("[pressed]");
  if (p.get("disabled") === true) parts.push("[disabled]");
  const expanded = p.get("expanded");
  if (expanded === true) parts.push("[expanded]");
  else if (expanded === false) parts.push("[collapsed]");
  if (p.get("selected") === true) parts.push("[selected]");
  if (p.get("focused") === true) parts.push("[focused]");
  const level = p.get("level");
  if (typeof level === "number") parts.push(`[level=${level}]`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function formatSnapshot(nodes: AxNode[], maxLines = MAX_SNAPSHOT_LINES): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => n.parentId === null || !byId.has(n.parentId));
  const lines: string[] = [];
  const refs = new Map<string, number>();
  const labels = new Map<string, string>();
  let truncated = false;
  let omitted = 0;
  const seen = new Set<string>();

  const emit = (line: string): void => {
    if (lines.length >= maxLines) {
      truncated = true;
      omitted++;
      return;
    }
    lines.push(line);
  };

  /** `echoes`: the parent's name and value, which its text children repeat. */
  const visit = (node: AxNode, depth: number, echoes: string[]): void => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const children = (): AxNode[] => node.childIds.map((id) => byId.get(id)).filter((c): c is AxNode => c !== undefined);
    const indent = "  ".repeat(depth);

    if (TEXT_ROLES.has(node.role)) {
      // A button's label, or a field's value, repeats as its text child.
      if (node.name && !echoes.includes(node.name)) emit(`${indent}- text: ${clip(node.name, MAX_TEXT)}`);
      return;
    }
    if (node.ignored || TRANSPARENT_ROLES.has(node.role) || !node.role) {
      for (const child of children()) visit(child, depth, echoes);
      return;
    }

    let line = `${indent}- ${node.role}`;
    if (node.name) line += ` ${JSON.stringify(clip(node.name, MAX_NAME))}`;
    line += attributes(node);
    // Past the limit nothing is shown, so nothing gets a ref.
    if (node.backendDOMNodeId !== null && lines.length < maxLines) {
      const ref = `e${refs.size + 1}`;
      refs.set(ref, node.backendDOMNodeId);
      labels.set(ref, node.name ? JSON.stringify(clip(node.name, 60)) : `the ${node.role}`);
      line += ` [ref=${ref}]`;
    }
    if (VALUE_ROLES.has(node.role) && node.value) line += `: ${clip(node.value, MAX_TEXT)}`;
    emit(line);
    for (const child of children()) visit(child, depth + 1, [node.name, node.value].filter(Boolean));
  };

  for (const root of roots) visit(root, 0, []);
  if (truncated) lines.push(`- … ${omitted} more lines not shown`);
  return { text: lines.join("\n"), refs, labels, truncated };
}
