/**
 * Small fuzzy matcher: every query character must appear in order. Scores favour contiguous runs,
 * matches at word starts (after . _ space or a case change) and shorter candidates.
 * Returns null when the query does not match.
 */
export function fuzzyScore(query: string, text: string): { score: number; positions: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  // fast path: substring
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const positions = Array.from({ length: q.length }, (_, i) => sub + i);
    const boundary = sub === 0 || /[._\s\-[\]]/.test(text[sub - 1] ?? '') ? 30 : 0;
    return { score: 100 + boundary + q.length * 4 - t.length * 0.2 - sub * 0.5, positions };
  }
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const before = text[found - 1] ?? '';
    const isBoundary = found === 0 || /[._\s\-[\]]/.test(before) || (/[a-z]/.test(before) && /[A-Z]/.test(text[found] ?? ''));
    score += found === prev + 1 ? 6 : 1;
    if (isBoundary) score += 5;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.2, positions };
}
