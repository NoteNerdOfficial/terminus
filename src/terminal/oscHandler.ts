import { Terminal } from "@xterm/xterm";

/** @xterm/xterm@6.0.0's public Terminal class does NOT actually expose
 *  registerOscHandler at runtime, despite it being declared in the
 *  package's own .d.ts (verified empirically, not assumed -- calling it
 *  throws "not a function"). It does exist on the internal
 *  _core._inputHandler, which is where the public method would delegate to
 *  if it were wired up; this is an undocumented but functional workaround.
 *  Falls back to a no-op if that internal shape ever changes, rather than
 *  crashing -- shell-integration features just won't activate, same as an
 *  unsupported shell. Shared by CommandTracker (OSC 133) and CwdTracker
 *  (OSC 7) rather than duplicated per-feature. */
export function registerOscHandlerSafe(
  term: Terminal,
  ident: number,
  callback: (data: string) => boolean
): { dispose(): void } {
  const inputHandler = (term as unknown as { _core?: { _inputHandler?: { registerOscHandler?: unknown } } })._core
    ?._inputHandler;
  if (inputHandler && typeof inputHandler.registerOscHandler === "function") {
    return (inputHandler.registerOscHandler as (i: number, cb: (data: string) => boolean) => { dispose(): void })(
      ident,
      callback
    );
  }
  console.warn(`Terminus: xterm registerOscHandler unavailable -- OSC ${ident} handling disabled.`);
  return { dispose() {} };
}
