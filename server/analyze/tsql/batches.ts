// Token-aware batch splitting: `GO [count]` alone on its line (trailing comments allowed).
// GO inside strings/comments never splits because those are single tokens.

import type { Token } from './tokenizer';

export interface Batch {
  index: number;      // 0-based among non-empty batches
  tokens: Token[];    // code tokens only (comments removed)
  startLine: number;
  endLine: number;
  repeat: number;     // GO <count> that terminated this batch (1 when absent)
}

export function splitBatches(all: Token[]): Batch[] {
  const code: Token[] = [];
  for (const t of all) if (t.type !== 'comment') code.push(t);

  const out: Batch[] = [];
  let cur: Token[] = [];
  const flush = (repeat: number): void => {
    if (cur.length > 0) {
      const first = cur[0] as Token;
      const last = cur[cur.length - 1] as Token;
      out.push({ index: out.length, tokens: cur, startLine: first.line, endLine: last.endLine, repeat });
    }
    cur = [];
  };

  for (let k = 0; k < code.length; k++) {
    const t = code[k] as Token;
    if (t.type === 'word' && t.upper === 'GO') {
      const prev = code[k - 1];
      const next = code[k + 1];
      const aloneBefore = !prev || prev.endLine < t.line;
      let consumed = 0;
      let repeat = 1;
      let aloneAfter = !next || next.line > t.endLine;
      if (!aloneAfter && next && next.type === 'number' && next.line === t.line) {
        const after = code[k + 2];
        if (!after || after.line > t.line) { aloneAfter = true; consumed = 1; repeat = Number.parseInt(next.value, 10) || 1; }
      }
      if (aloneBefore && aloneAfter) {
        flush(repeat);
        k += consumed;
        continue;
      }
    }
    cur.push(t);
  }
  flush(1);
  return out;
}
