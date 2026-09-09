/** NFKC search with literal SQL wildcard escaping. */
export function searchPattern(query: string) {
  return `%${query.normalize("NFKC").replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
