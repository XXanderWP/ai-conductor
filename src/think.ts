/**
 * `<think>…</think>` block removal for reasoning models that inline their thoughts.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/** Remove `<think>…</think>` blocks (and a trailing unclosed block). Returns visible text and thoughts. */
export function stripThinkBlocks(text: string): { text: string; thinking: string } {
  const stripper = new ThinkStripper();
  const visible = stripper.push(text) + stripper.flush();
  return { text: visible, thinking: stripper.thinking };
}

/**
 * Streaming `<think>` filter: feed deltas with {@link push}, which returns only the visible part.
 * Tags split across chunks are buffered; an unclosed block stays hidden.
 */
export class ThinkStripper {
  /** Collected text from inside think blocks. */
  thinking = '';
  private inside = false;
  private pending = '';

  constructor(private readonly onThinking?: (text: string) => void) {}

  push(delta: string): string {
    let input = this.pending + delta;
    this.pending = '';
    let visible = '';

    while (input) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = input.indexOf(tag);
      if (at >= 0) {
        this.emit(input.slice(0, at), (s) => (visible += s));
        input = input.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // Keep a possible partial tag at the end for the next chunk.
      const keep = partialSuffix(input, tag);
      this.emit(input.slice(0, input.length - keep), (s) => (visible += s));
      this.pending = input.slice(input.length - keep);
      break;
    }
    return visible;
  }

  /** Flush buffered text at the end of a stream (an unclosed block is dropped). */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    if (this.inside) {
      this.addThinking(rest);
      return '';
    }
    return rest;
  }

  private emit(text: string, visible: (s: string) => void): void {
    if (!text) return;
    if (this.inside) this.addThinking(text);
    else visible(text);
  }

  private addThinking(text: string): void {
    if (!text) return;
    this.thinking += text;
    this.onThinking?.(text);
  }
}

function partialSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n -= 1) {
    if (tag.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}
