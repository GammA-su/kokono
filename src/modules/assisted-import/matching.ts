import { normalizedName } from "../catalog/duplicates";
import type { Candidate } from "./types";
export type References = {
  categories: { id: string; name: string; slug: string }[];
  characters: {
    id: string;
    name: string;
    japaneseName: string | null;
    aliases: string[];
  }[];
};
const categoryTerms: Record<string, string[]> = {
  アクリルスタンド: ["Acrylic Stand", "Acrylic Stands"],
  缶バッジ: ["Can Badge", "Can Badges", "Badge", "Badges"],
  クリアファイル: ["Clear File", "Clear Files"],
  タペストリー: ["Tapestry", "Tapestries"],
};
export function matchReferences(row: Candidate, refs: References): Candidate {
  const warnings = [...row.warnings];
  const terms = [row.categoryTerm, ...(categoryTerms[row.categoryTerm] ?? [])]
    .filter(Boolean)
    .map(normalizedName);
  const categories = refs.categories.filter(
    (category) =>
      terms.includes(normalizedName(category.name)) ||
      terms.includes(normalizedName(category.slug)),
  );
  if (categories.length !== 1)
    warnings.push(
      `Category needs confirmation${row.categoryTerm ? `: ${row.categoryTerm}` : " (not found on source)"}.`,
    );
  const ids: string[] = [];
  for (const name of row.characterNames) {
    const matches = refs.characters.filter((character) =>
      [character.name, character.japaneseName, ...character.aliases]
        .filter(Boolean)
        .some((value) => normalizedName(value!) === normalizedName(name)),
    );
    if (matches.length === 1) ids.push(matches[0].id);
    else
      warnings.push(
        `Unresolved or ambiguous character: ${name}. Select an existing character or deliberately omit it.`,
      );
  }
  if (!row.characterNames.length) {
    // Literal Japanese names from this franchise are suggestions only; no taxonomy is created.
    for (const character of refs.characters)
      if (
        character.japaneseName &&
        row.japaneseName.includes(character.japaneseName)
      )
        ids.push(character.id);
    if (ids.length)
      warnings.push(
        "Characters were suggested from the Japanese title. Confirm the associations.",
      );
  }
  return {
    ...row,
    characterIds: [...new Set(ids)].slice(0, 50),
    categoryId: categories.length === 1 ? categories[0].id : "",
    warnings: warnings.slice(0, 30),
  };
}
