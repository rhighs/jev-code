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

export const numberCandidates = (objective: string): number[] =>
  [...new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100, 1000, -1, ...((objective.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number))])].filter(Number.isFinite).slice(0, 200);
