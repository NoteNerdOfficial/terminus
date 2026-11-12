import type { BrowserActivity } from "./BrowserDriver";

/** How long a click's hop lasts; matches the CSS animation. */
const CLICK_MS = 520;
/** How long an expression shows. */
const EXPRESSION_MS = 1800;
/** How long the companion keeps typing or reading after the action. */
const BUSY_MS = 1400;
/** Matches the cursor's glide in CSS. */
const GLIDE_MS = 650;
/** Room the speech bubble needs on its right before it flips to the left. */
const BUBBLE_ROOM = 360;
/** Where the companion first appears when the agent's first action has no
 *  place on the page (reading it, say). */
const ENTRY = { x: 28, y: 28 };

type Mood = "clicking" | "typing" | "reading";

/** Faces and effects for moments beyond the actions themselves. */
export type Expression = "hello" | "love" | "wow" | "cool" | "alarm" | "cross" | "sad";

/*
 * Pixel art, one string per row: o outline, w highlight, l body, d deep
 * (the body colours are tints of the agent's colour), e ink (eyes,
 * mouth), p blush, r red, y yellow, t blue, g green, a grey, . nothing.
 * Arms and legs come in frames, swapped by CSS to make it walk.
 */
const CURSOR = [
  "ooooooo.",
  "owwwwwwo",
  "owlllldo",
  "owlldddo",
  "owldooo.",
  "owldo...",
  "odddo...",
  ".ooo....",
];

const BODY = [
  ".....l..........",
  "......o.........",
  "....oooooo......",
  "...owwowwwo.....",
  "..ollloolllo....",
  ".owllddddllwo...",
  ".olwwwwwwwwlo...",
  ".odlllllllldo...",
  ".odlllllllldo...",
  ".odlllllllldo...",
  ".odlllllllldo...",
  ".odlllllllldo...",
  "..oddddddddo....",
  "...oooooooo.....",
];

/** Rows 14-16, below the body: standing, then mid-step. */
const LEGS = [
  ["....o....o......", "....o....o......", "...oo....oo....."],
  ["....o....o......", "...o......o.....", "..oo......oo...."],
];

/** Beside the body: as drawn, swung down, and both up for cheering. */
const ARMS = [
  ["................", "................", "................", "................", "................", "................", "................", "..............o.", "o............o..", "................", "................", "................", "................", "................"],
  ["................", "................", "................", "................", "................", "................", "................", "................", ".............o..", "o.............o.", "................", "................", "................", "................"],
  ["................", "................", "................", "................", "................", "..............o.", "o............o..", "o............o..", "................", "................", "................", "................", "................", "................"],
];

/** Faces, drawn over body rows 8-10. "plain" shows when no other one does. */
const FACES: Record<string, string[]> = {
  plain: ["................", "....e....e......", "...pp....pp....."],
  happy: ["....e....e......", "...e.e..e.e.....", "...pp....pp....."],
  wow: ["....e....e......", "....e....e......", "...p..ee..p....."],
  cool: ["..eeeeeeeeee....", "...ewe..eee.....", "...pp....pp....."],
  cross: [".....e..e.......", "....e....e......", "...pp....pp....."],
  sad: ["...e......e.....", "....e....e......", "....t....t......"],
  sleepy: ["................", "...ee....ee.....", "...pp....pp....."],
};

/** Effects around the companion, [rows, left, top] in sprite pixels. */
const EFFECTS: Record<string, [string[], number, number][]> = {
  zzz: [[["eee", "..e", ".e.", "e..", "eee"], 14, -5]],
  love: [[[".r.r.", "rrrrr", "rwrrr", ".rrr.", "..r.."], 14, -6]],
  alarm: [[["r.r.r", "r.r.r", "r.r.r", ".....", "r.r.r"], 14, -6]],
  cross: [
    [[".r.r.", "rr.rr", ".....", "rr.rr", ".r.r."], 13, -5],
    [["aa.", "..a", ".a.", "a..", ".aa"], 4, -7],
  ],
  wow: [
    [["y"], -3, 2], [["t"], 18, 1], [["p"], -2, 9], [["g"], 18, 8],
    [["t"], 1, -3], [["y"], 14, -3], [["g"], 5, -6], [["p"], 11, -5],
  ],
  sad: [[["t", "t"], 4, 11], [["t", "t"], 12, 11]],
  hello: [[["y.y", ".y.", "y.y"], 15, -4]],
};

/** The sprite's drawing area, in its own pixels: room around the 16 x 17
 *  companion for effects. Matches the buddy's size and offset in CSS. */
const VIEW = { left: -5, top: -7, width: 26, height: 24 };

/** Draws pixel rows into an SVG group, one rect per run of a colour. */
function drawPixels(group: SVGElement, rows: string[], top = 0, left = 0): void {
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === c) end++;
      if (c !== ".") {
        const attr = { x: String(left + x), y: String(top + y), width: String(end - x), height: "1" };
        group.createSvg("rect", { cls: `px-${c}`, attr });
      }
      x = end;
    }
  });
}

/** What the companion does for each of the driver's verbs, and how its
 *  bubble says it while it's happening. */
function describe(verb: string): { mood: Mood | null; doing: string } {
  const table: [RegExp, Mood | null, string][] = [
    [/^Double-clicked/, "clicking", "Double-clicking"],
    [/^Clicked/, "clicking", "Clicking"],
    [/^Typed into/, "typing", "Typing into"],
    [/^Added to/, "typing", "Adding to"],
    [/^Pressed/, "typing", "Pressing"],
    [/^Picked/, "clicking", verb.replace(/^Picked/, "Picking")],
    [/^Read/, "reading", "Reading"],
    [/^Took/, "reading", "Taking"],
  ];
  for (const [pattern, mood, doing] of table) if (pattern.test(verb)) return { mood, doing };
  return { mood: null, doing: verb };
}

/**
 * The agent's own cursor on the page, in pixel art: a pointer whose tip
 * marks exactly where it acts, a small companion beside it, and a speech
 * bubble saying what it's doing. The companion is drawn in the agent's
 * group colour and never stands still: it marches on the spot, walks
 * faster (facing the way it goes) as it travels, taps its arms while
 * typing, looks around while reading, hops on a click, and dozes with a
 * floating z once the agent goes quiet. It also pulls faces at moments
 * that matter (see `express`): a wave hello, a heart, sunglasses for a
 * screenshot, alarm at a console error, a cross face when an action is
 * refused, tears when a page won't load.
 *
 * Purely visual: nothing here takes pointer events or touches the page.
 */
export class AgentCursor {
  private readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly doingEl: HTMLElement;
  private readonly targetEl: HTMLElement;
  private readonly bubble: HTMLElement;
  private readonly ripples: HTMLElement;
  private at: { x: number; y: number } | null = null;
  private moodTimer = 0;
  private glideTimer = 0;
  private expressionTimer = 0;
  private expression: Expression | null = null;

  constructor(stage: HTMLElement, name: string) {
    this.ripples = stage.createDiv({ cls: "terminus-agent-browser-ripples" });
    this.el = stage.createDiv({ cls: ["terminus-agent-cursor", "is-resting"] });
    this.el.hide();

    const arrow = this.el.createSvg("svg", {
      cls: "terminus-agent-cursor-arrow",
      attr: { viewBox: `0 0 ${CURSOR[0]!.length} ${CURSOR.length}`, "shape-rendering": "crispEdges", "aria-hidden": "true" },
    });
    drawPixels(arrow, CURSOR);

    const buddy = this.el.createDiv({ cls: "terminus-agent-cursor-buddy" });
    const svg = buddy.createSvg("svg", {
      attr: { viewBox: `${VIEW.left} ${VIEW.top} ${VIEW.width} ${VIEW.height}`, "shape-rendering": "crispEdges", "aria-hidden": "true" },
    });
    const sprite = svg.createSvg("g", { cls: "buddy-sprite" });
    drawPixels(sprite.createSvg("g", { cls: "buddy-body" }), BODY);
    for (const [name, rows] of Object.entries(FACES)) drawPixels(sprite.createSvg("g", { cls: ["buddy-face", `buddy-face-${name}`] }), rows, 8);
    LEGS.forEach((rows, i) => drawPixels(sprite.createSvg("g", { cls: ["buddy-legs", `buddy-frame-${i}`] }), rows, BODY.length));
    ARMS.forEach((rows, i) => drawPixels(sprite.createSvg("g", { cls: ["buddy-arms", i < 2 ? `buddy-frame-${i}` : "buddy-arms-up"] }), rows, 0));
    for (const [name, parts] of Object.entries(EFFECTS)) {
      const group = svg.createSvg("g", { cls: ["buddy-fx", `buddy-fx-${name}`] });
      parts.forEach(([rows, left, top], i) => drawPixels(group.createSvg("g", { cls: `buddy-fx-part-${i}` }), rows, top, left));
    }

    this.bubble = this.el.createDiv({ cls: "terminus-agent-cursor-bubble" });
    this.nameEl = this.bubble.createSpan({ cls: "terminus-agent-cursor-name", text: name });
    const line = this.bubble.createSpan({ cls: "terminus-agent-cursor-line" });
    this.doingEl = line.createSpan({ cls: "terminus-agent-cursor-doing" });
    this.targetEl = line.createSpan({ cls: "terminus-agent-cursor-target" });
  }

  setName(name: string): void {
    this.nameEl.setText(name);
  }

  /** Acts out one of the agent's actions. */
  show(activity: BrowserActivity): void {
    const { mood, doing } = describe(activity.verb);
    this.say(doing, activity.target);
    // The first time it appears, it waves hello.
    if (!this.at) this.express("hello");

    const point = activity.point ?? this.at ?? ENTRY;
    const stageWidth = this.el.parentElement?.clientWidth ?? 0;
    if (!this.at || point.x !== this.at.x || point.y !== this.at.y) this.glide(point);
    this.el.toggleClass("is-flipped", point.x > stageWidth - BUBBLE_ROOM);
    this.el.removeClass("is-resting");
    this.el.show();

    window.clearTimeout(this.moodTimer);
    this.el.removeClass("is-clicking", "is-typing", "is-reading");
    if (mood) {
      // A click lands when the glide does.
      const delay = mood === "clicking" && this.el.hasClass("is-moving") ? GLIDE_MS * 0.7 : 0;
      window.setTimeout(() => {
        this.pop(this.el, `is-${mood}`);
        if (mood === "clicking" && activity.point) this.ripple(activity.point);
      }, delay);
      this.moodTimer = window.setTimeout(() => this.el.removeClass(`is-${mood}`), delay + (mood === "clicking" ? CLICK_MS : BUSY_MS));
    }
  }

  /**
   * Pulls a face for a moment: a heart, sunglasses, alarm. With `say`, the
   * bubble says what happened. Wakes the companion if it was dozing, and
   * lets it doze again afterwards.
   */
  express(expression: Expression, say?: { doing: string; target: string }): void {
    if (say) this.say(say.doing, say.target);
    const wasResting = this.el.hasClass("is-resting");
    if (!this.at) {
      this.glide(ENTRY);
      this.el.show();
    }
    this.el.removeClass("is-resting");
    if (this.expression) this.el.removeClass(`is-expr-${this.expression}`);
    this.expression = expression;
    this.pop(this.el, `is-expr-${expression}`);
    window.clearTimeout(this.expressionTimer);
    this.expressionTimer = window.setTimeout(() => {
      this.el.removeClass(`is-expr-${expression}`);
      this.expression = null;
      if (wasResting && !this.el.hasClass("is-clicking") && !this.el.hasClass("is-typing") && !this.el.hasClass("is-reading")) {
        this.el.addClass("is-resting");
      }
    }, EXPRESSION_MS);
  }

  /** The agent has gone quiet: only the dozing companion stays. */
  rest(): void {
    this.el.removeClass("is-clicking", "is-typing", "is-reading", "is-moving");
    this.el.addClass("is-resting");
  }

  dispose(): void {
    window.clearTimeout(this.moodTimer);
    window.clearTimeout(this.glideTimer);
    window.clearTimeout(this.expressionTimer);
  }

  private say(doing: string, target: string): void {
    this.doingEl.setText(doing);
    this.targetEl.setText(target);
    this.pop(this.bubble, "is-new");
  }

  private glide(to: { x: number; y: number }): void {
    const from = this.at ?? to;
    const dx = to.x - from.x;
    // Turns to face the way it's going.
    if (Math.abs(dx) > 4) this.el.toggleClass("is-facing-left", dx < 0);
    this.el.setCssProps({ "--terminus-cursor-x": `${to.x}px`, "--terminus-cursor-y": `${to.y}px` });
    this.at = { x: to.x, y: to.y };
    if (from === to) return;
    this.el.addClass("is-moving");
    window.clearTimeout(this.glideTimer);
    this.glideTimer = window.setTimeout(() => this.el.removeClass("is-moving"), GLIDE_MS);
  }

  private ripple(point: { x: number; y: number }): void {
    const ripple = this.ripples.createDiv({ cls: "terminus-agent-browser-ripple" });
    ripple.setCssProps({ "--terminus-cursor-x": `${point.x}px`, "--terminus-cursor-y": `${point.y}px` });
    window.setTimeout(() => ripple.remove(), 800);
  }

  /** Re-adds a class so its CSS animation plays again. */
  private pop(el: HTMLElement, cls: string): void {
    el.removeClass(cls);
    void el.offsetWidth;
    el.addClass(cls);
  }
}
