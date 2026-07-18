import { Terminal } from "@xterm/xterm";
import { registerOscHandlerSafe } from "./oscHandler";

/**
 * Tracks the spawned shell's current working directory via a plain-path OSC
 * 7 emitted from resources/shell-integration/{zsh,bash}'s precmd hooks (see
 * those files for why it's a bare path, not the file://host/path form other
 * terminals use for OSC 7 -- Terminus is the only consumer). Lets a
 * restored terminal (see TerminalView.getState/setState) resume its shell
 * in the directory it was last in, instead of always the vault root.
 */
export class CwdTracker {
  private cwd: string | null = null;
  private readonly oscHandler: { dispose(): void };

  constructor(term: Terminal, onChange?: (cwd: string) => void) {
    this.oscHandler = registerOscHandlerSafe(term, 7, (data) => {
      this.cwd = data;
      onChange?.(data);
      return true;
    });
  }

  getCwd(): string | null {
    return this.cwd;
  }

  dispose(): void {
    this.oscHandler.dispose();
  }
}
