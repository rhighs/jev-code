export const objectiveWords = (objective: string): string[] => objective.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? [];

export const identifierCandidates = (words: string[], keywords: Set<string>, seeds: string[]): string[] =>
  [...new Set([...words.filter(w => /^[a-z_][a-z_0-9]*$/.test(w) && !keywords.has(w)), ...seeds])].slice(0, 180);

export const quotedLiterals = (objective: string): string[] =>
  [...objective.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g)].map(m => m[1] ?? m[2] ?? m[3]!);

export const phraseLiterals = (words: string[]): string[] => {
  const literals: string[] = [];
  for (let start = 0; start < words.length; start++) for (let count = 1; count <= 3 && start + count <= words.length; count++) {
    const phrase = words.slice(start, start + count).join(' ');
    const capital = phrase[0]!.toUpperCase() + phrase.slice(1);
    literals.push(phrase, capital, capital + '!');
    if (count > 1) literals.push(words[start]![0]!.toUpperCase() + words[start]!.slice(1) + ', ' + words.slice(start + 1, start + count).join(' ') + '!');
  }
  return literals;
};

export const stringCandidates = (literals: string[]): string[] => [...new Set(literals)].slice(0, 220);

/** Multi-character separators and punctuation: one pick advances several characters. */
const separatorPieces = [', ', ': ', '! ', '? ', '. ', '\n', ',', ':', '!', '?', '.', ' '];

const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');

/** Choice accepts at most 255 labels; 240 pieces also keeps one token request inside the byte cap. */
export const STRING_PIECE_LIMIT = 240;

/** Enrichment is bounded so the separator and alphabet pieces always survive the cap. */
const maxEnrichment = 160;

/**
 * Pieces for the `custom` string path: quoted task literals, phrase fragments, identifiers and
 * words, then separators and the single-character alphabet. A task-derived literal is one pick;
 * a novel string is still spellable piece by piece.
 */
export const stringPieces = (objective: string, words: string[], identifiers: readonly string[]): string[] => {
  const enrichment = [...new Set([...quotedLiterals(objective), ...phraseLiterals(words), ...identifiers, ...words])].slice(0, maxEnrichment);
  return [...new Set([...enrichment, ...separatorPieces, ...alphabet])].slice(0, STRING_PIECE_LIMIT);
};

/**
 * The pieces offered at one custom-string token step: continuations that extend the accumulated
 * `result` into a known candidate, longest first (one pick advances several characters), then the
 * base pieces. A piece that already starts with `result` would duplicate its prefix, so it is
 * replaced by its continuations. The offered list stays within the Choice label limit.
 */
export const stringTokenPieces = (result: string, pieces: readonly string[], candidates: readonly string[]): string[] => {
  const limit = Math.max(0, Math.min(24, STRING_PIECE_LIMIT - pieces.length));
  const continuations = result.length === 0 || limit === 0 ? [] : [...new Set(candidates
    .filter(candidate => candidate.length > result.length && candidate.startsWith(result))
    .map(candidate => candidate.slice(result.length)))]
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
  const base = result.length === 0 ? pieces : pieces.filter(piece => !(piece.length > result.length && piece.startsWith(result)));
  return [...new Set([...continuations, ...base])];
};

export const numberCandidates = (objective: string): number[] =>
  [...new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100, 1000, -1, ...((objective.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number))])].filter(Number.isFinite).slice(0, 200);
