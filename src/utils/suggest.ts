/**
 * Suggest close string matches (typo helpers for provider ids / CLI).
 */

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

/**
 * Return closest candidates for a typo / partial id.
 * Prefers prefix matches, then small edit distance.
 */
export function suggestClosest(input: string, candidates: readonly string[], limit = 5): string[] {
  const needle = input.trim().toLowerCase();
  if (!needle) {
    return [...candidates].slice(0, limit);
  }

  const scored = candidates
    .map((candidate) => {
      const hay = candidate.toLowerCase();
      let score = levenshtein(needle, hay);
      if (hay.startsWith(needle)) score -= 3;
      if (hay.includes(needle)) score -= 1;
      return { candidate, score };
    })
    .filter(({ score, candidate }) => {
      const maxDistance = Math.max(2, Math.floor(candidate.length / 3));
      return score <= maxDistance;
    })
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const { candidate } of scored) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

/** Build a human-readable "did you mean" suffix. */
export function formatSuggestions(input: string, candidates: readonly string[]): string {
  const suggestions = suggestClosest(input, candidates);
  if (suggestions.length === 0) {
    return candidates.length ? `Available: ${candidates.join(', ')}.` : 'No candidates available.';
  }
  return `Did you mean: ${suggestions.join(', ')}?`;
}
