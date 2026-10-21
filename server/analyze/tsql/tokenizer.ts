// T-SQL tokenizer: nested /* */ and -- comments, N'…' strings with '' escapes,
// [a]]b] and "x" identifiers ("x" is a string when QUOTED_IDENTIFIER is OFF),
// @var, @@sys, #temp/##global, $(sqlcmd) placeholders, numbers and operators.
// Lines and columns are 1-based. Never throws; unterminated constructs become warnings.

export type TokenType =
  | 'word'        // unquoted identifier or keyword
  | 'ident'       // [bracketed] or "double-quoted" identifier
  | 'temp'        // #local / ##global temp object name
  | 'variable'    // @name
  | 'sysvar'      // @@NAME
  | 'placeholder' // $(name) — sqlcmd / Elastic Jobs token
  | 'string'
  | 'number'
  | 'op'
  | '(' | ')' | ',' | ';' | '.'
  | 'comment';

export interface Token {
  type: TokenType;
  value: string;   // raw source text
  name: string;    // unquoted name for word/ident/temp; raw value otherwise
  upper: string;   // name.toUpperCase()
  start: number;   // source offset (inclusive)
  end: number;     // source offset (exclusive)
  line: number;    // 1-based start line
  col: number;     // 1-based start column
  endLine: number; // 1-based line of the last character
  quoted: boolean; // bracketed / double-quoted identifier
}

export interface TokenizeResult { tokens: Token[]; warnings: Array<{ line: number | null; message: string }> }

const MULTI_OPS = new Set(['<=', '>=', '<>', '!=', '!<', '!>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::', '||']);

function isIdStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 /* _ */ || (c >= 0xc0 && !isExtraSpace(c));
}
function isIdChar(c: number): boolean {
  return isIdStart(c) || (c >= 48 && c <= 57) || c === 64 /* @ */ || c === 35 /* # */ || c === 36 /* $ */;
}
function isDigit(c: number): boolean { return c >= 48 && c <= 57; }
function isExtraSpace(c: number): boolean {
  return c === 0xa0 || c === 0xfeff || (c >= 0x2000 && c <= 0x200b) || c === 0x2028 || c === 0x2029 || c === 0x3000 || c === 0x1680 || c === 0x202f || c === 0x205f;
}

export function tokenize(src: string, opts: { quotedIdentifier?: boolean } = {}): TokenizeResult {
  const tokens: Token[] = [];
  const warnings: Array<{ line: number | null; message: string }> = [];
  let quotedIdentifier = opts.quotedIdentifier !== false;
  const n = src.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  // last two code (non-comment) tokens, to detect SET QUOTED_IDENTIFIER ON|OFF in-script
  let code1: Token | null = null;
  let code2: Token | null = null;

  const push = (type: TokenType, start: number, end: number, startLine: number, startCol: number, name?: string, quoted = false): Token => {
    const value = src.slice(start, end);
    const nm = name ?? value;
    const tok: Token = { type, value, name: nm, upper: nm.toUpperCase(), start, end, line: startLine, col: startCol, endLine: line, quoted };
    tokens.push(tok);
    if (type !== 'comment') {
      if (type === 'word' && (tok.upper === 'ON' || tok.upper === 'OFF') && code1 && code2 &&
        code1.type === 'word' && code1.upper === 'QUOTED_IDENTIFIER' && code2.type === 'word' && code2.upper === 'SET') {
        quotedIdentifier = tok.upper === 'ON';
      }
      code2 = code1; code1 = tok;
    }
    return tok;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    const c2 = i + 1 < n ? src.charCodeAt(i + 1) : -1;
    const s = i;
    const sl = line;
    const sc = i - lineStart + 1;

    if (c === 10) { i++; line++; lineStart = i; continue; }
    if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11 || c === 0 || isExtraSpace(c)) { i++; continue; }

    // -- line comment
    if (c === 45 && c2 === 45) {
      while (i < n && src.charCodeAt(i) !== 10) i++;
      let e = i; if (e > s && src.charCodeAt(e - 1) === 13) e--;
      push('comment', s, e, sl, sc);
      continue;
    }
    // /* nested block comment */
    if (c === 47 && c2 === 42) {
      let depth = 0;
      let closed = false;
      while (i < n) {
        const a = src.charCodeAt(i);
        const b = i + 1 < n ? src.charCodeAt(i + 1) : -1;
        if (a === 47 && b === 42) { depth++; i += 2; continue; }
        if (a === 42 && b === 47) { depth--; i += 2; if (depth === 0) { closed = true; break; } continue; }
        if (a === 10) { line++; lineStart = i + 1; }
        i++;
      }
      push('comment', s, i, sl, sc);
      if (!closed) warnings.push({ line: sl, message: 'Unterminated block comment (/* without matching */)' });
      continue;
    }
    // strings: '…', N'…', and "…" when QUOTED_IDENTIFIER is OFF
    const isNStr = (c === 78 || c === 110) && c2 === 39;
    if (c === 39 || isNStr || (c === 34 && !quotedIdentifier)) {
      const q = isNStr ? 39 : c;
      i += isNStr ? 2 : 1;
      let closed = false;
      while (i < n) {
        const a = src.charCodeAt(i);
        if (a === q) {
          if (i + 1 < n && src.charCodeAt(i + 1) === q) { i += 2; continue; }
          i++; closed = true; break;
        }
        if (a === 10) { line++; lineStart = i + 1; }
        i++;
      }
      push('string', s, i, sl, sc);
      if (!closed) warnings.push({ line: sl, message: 'Unterminated string literal' });
      continue;
    }
    // [bracketed]]ident] and "quoted""ident"
    if (c === 91 || c === 34) {
      const close = c === 91 ? 93 : 34;
      i++;
      let name = '';
      let closed = false;
      let segStart = i;
      while (i < n) {
        const a = src.charCodeAt(i);
        if (a === close) {
          if (i + 1 < n && src.charCodeAt(i + 1) === close) { name += src.slice(segStart, i + 1); i += 2; segStart = i; continue; }
          name += src.slice(segStart, i);
          i++; closed = true; break;
        }
        if (a === 10) { line++; lineStart = i + 1; }
        i++;
      }
      if (!closed) {
        name += src.slice(segStart, i);
        warnings.push({ line: sl, message: `Unterminated quoted identifier (${c === 91 ? '[' : '"'} without closing ${c === 91 ? ']' : '"'})` });
      }
      push('ident', s, i, sl, sc, name, true);
      continue;
    }
    // @variable / @@SYSVAR
    if (c === 64) {
      i++;
      const sys = i < n && src.charCodeAt(i) === 64;
      if (sys) i++;
      while (i < n && isIdChar(src.charCodeAt(i))) i++;
      push(sys ? 'sysvar' : 'variable', s, i, sl, sc);
      continue;
    }
    // #temp / ##global
    if (c === 35) {
      i++;
      if (i < n && src.charCodeAt(i) === 35) i++;
      while (i < n && isIdChar(src.charCodeAt(i))) i++;
      push('temp', s, i, sl, sc);
      continue;
    }
    // $(placeholder) used by sqlcmd and Elastic Jobs ($(job_name), $(job_execution_id) …)
    if (c === 36 && c2 === 40) {
      let j = i + 2;
      while (j < n && j - i < 200 && src.charCodeAt(j) !== 41 && src.charCodeAt(j) !== 10) j++;
      if (j < n && src.charCodeAt(j) === 41) { i = j + 1; push('placeholder', s, i, sl, sc); continue; }
    }
    // $action / $IDENTITY / $ROWGUID pseudo-columns
    if (c === 36 && isIdStart(c2)) {
      i++;
      while (i < n && isIdChar(src.charCodeAt(i))) i++;
      push('word', s, i, sl, sc);
      continue;
    }
    // numbers: 12, 1.5, .5, 1e10, 0x1F, $12.50
    if (isDigit(c) || (c === 46 && isDigit(c2)) || (c === 36 && (isDigit(c2) || c2 === 46))) {
      if (c === 36) i++;
      if (src.charCodeAt(i) === 48 && (src.charCodeAt(i + 1) === 120 || src.charCodeAt(i + 1) === 88)) {
        i += 2;
        while (i < n && /[0-9A-Fa-f]/.test(src[i] as string)) i++;
      } else {
        while (i < n && (isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 46)) i++;
        const e1 = src.charCodeAt(i);
        const e2 = src.charCodeAt(i + 1);
        if ((e1 === 101 || e1 === 69) && (isDigit(e2) || e2 === 43 || e2 === 45)) {
          i += 2;
          while (i < n && isDigit(src.charCodeAt(i))) i++;
        }
      }
      push('number', s, i, sl, sc);
      continue;
    }
    if (isIdStart(c)) {
      while (i < n && isIdChar(src.charCodeAt(i))) i++;
      push('word', s, i, sl, sc);
      continue;
    }
    // punctuation and operators
    if (c === 40) { i++; push('(', s, i, sl, sc); continue; }
    if (c === 41) { i++; push(')', s, i, sl, sc); continue; }
    if (c === 44) { i++; push(',', s, i, sl, sc); continue; }
    if (c === 59) { i++; push(';', s, i, sl, sc); continue; }
    if (c === 46) { i++; push('.', s, i, sl, sc); continue; }
    const two = src.slice(i, i + 2);
    if (MULTI_OPS.has(two)) { i += 2; push('op', s, i, sl, sc); continue; }
    // surrogate pairs and any other character become single-char op tokens
    i += (c >= 0xd800 && c <= 0xdbff && i + 1 < n) ? 2 : 1;
    push('op', s, i, sl, sc);
  }
  return { tokens, warnings };
}

/** Count lines like an editor: 'a' → 1, 'a\n' → 1, 'a\nb' → 2, '' → 0. */
export function countLines(src: string): number {
  if (src.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10 && i < src.length - 1) count++;
  return count;
}
