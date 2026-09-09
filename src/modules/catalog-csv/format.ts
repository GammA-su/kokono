import { DomainError } from "../shared/errors";

export const CSV_FORMAT = "kokono-catalog-v1";
export const MAX_IMPORT_ROWS = 250;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const csvColumns = [
  "csv_format",
  "lineup_id",
  "lineup_name",
  "franchise_name",
  "internal_sku",
  "name",
  "japanese_name",
  "characters",
  "category",
  "official_msrp_amount",
  "official_msrp_currency",
  "official_msrp_tax_state",
  "jan_code",
  "release_date",
  "release_date_precision",
  "manufacturer",
  "source_provider",
  "source_type",
  "source_url",
  "sources_json",
  "marketplace_search_query",
  "watch_enabled",
  "watch_target_quantity",
  "watch_max_price_amount",
  "watch_max_price_currency",
  "watch_priority",
  "watch_condition",
  "private_notes",
  "image_url",
] as const;
export type CsvColumn = (typeof csvColumns)[number];
export type CsvRow = Partial<Record<CsvColumn, string>>;

/** Quote every field; spreadsheet-safe escaping is reversible only for our marked format. */
export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (
    text.startsWith("'") ||
    /^[\t\r\n]/.test(text) ||
    /^[=+\-@]/.test(text.normalize("NFKC").trimStart())
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvRecord(values: unknown[]) {
  return values.map(csvCell).join(",") + "\r\n";
}
export function encodeCharacters(names: string[]) {
  return names
    .map((name) => name.replaceAll("\\", "\\\\").replaceAll("|", "\\|"))
    .join("|");
}
export function decodeCharacters(value: string) {
  const names: string[] = [];
  let part = "",
    escape = false;
  for (const character of value) {
    if (escape) {
      if (character !== "\\" && character !== "|")
        throw new DomainError(
          "CSV_CHARACTERS",
          "Character names escape only pipes (\\|) and backslashes (\\\\).",
        );
      part += character;
      escape = false;
    } else if (character === "\\") escape = true;
    else if (character === "|") {
      names.push(part.trim());
      part = "";
    } else part += character;
  }
  if (escape)
    throw new DomainError(
      "CSV_CHARACTERS",
      "A character name ends with an incomplete escape.",
    );
  names.push(part.trim());
  if (names.some((name) => !name))
    throw new DomainError(
      "CSV_CHARACTERS",
      "Empty character names are not allowed between separators.",
    );
  return [...new Set(names)];
}

/** Strict comma-delimited UTF-8 CSV. Embedded quotes/newlines are supported; broken records fail closed. */
export function parseCatalogCsv(input: string): {
  headers: CsvColumn[];
  rows: CsvRow[];
} {
  if (Buffer.byteLength(input, "utf8") > MAX_CSV_BYTES)
    throw new DomainError("CSV_SIZE", "CSV files must be at most 2 MiB.");
  const text = input.replace(/^\uFEFF/, "");
  if (text.includes("\0") || text.includes("\uFFFD"))
    throw new DomainError(
      "CSV_ENCODING",
      "Use valid UTF-8 CSV without NUL or replacement characters.",
    );
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
    if (row.length > 100)
      throw new DomainError("CSV_COLUMNS", "Too many CSV columns.");
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value !== "")) records.push(row);
    row = [];
    if (records.length > MAX_IMPORT_ROWS + 1)
      throw new DomainError(
        "CSV_ROWS",
        `Import at most ${MAX_IMPORT_ROWS} rows at a time.`,
      );
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === ",") endCell();
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (closed)
      throw new DomainError(
        "CSV_SYNTAX",
        `Unexpected text after a closing quote in record ${records.length + 1}.`,
      );
    else if (c === '"') {
      if (cell)
        throw new DomainError(
          "CSV_SYNTAX",
          `Unexpected quote in record ${records.length + 1}.`,
        );
      quoted = true;
    } else cell += c;
  }
  if (quoted)
    throw new DomainError(
      "CSV_SYNTAX",
      "The CSV contains an unterminated quoted field.",
    );
  if (cell || row.length || closed) endRow();
  if (!records.length) throw new DomainError("CSV_EMPTY", "The CSV is empty.");
  const headers = records[0].map((value) => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length)
    throw new DomainError(
      "CSV_HEADERS",
      "Duplicate column names are not allowed.",
    );
  for (const header of headers) {
    if (
      /stock|inventory|quantity_delta|location|owned|fulfillable/i.test(header)
    )
      throw new DomainError(
        "CSV_STOCK",
        `Stock column '${header}' is forbidden. Receive or adjust stock through InventoryMovement operations.`,
      );
    if (!(csvColumns as readonly string[]).includes(header))
      throw new DomainError(
        "CSV_HEADERS",
        `Unsupported column '${header}'. Use the catalog CSV template.`,
      );
  }
  if (
    !headers.includes("internal_sku") &&
    !headers.includes("name") &&
    !headers.includes("japanese_name")
  )
    throw new DomainError(
      "CSV_HEADERS",
      "Include internal_sku, name or japanese_name to identify merchandise.",
    );
  const rows = records.slice(1).map((values, index) => {
    if (values.length !== headers.length)
      throw new DomainError(
        "CSV_COLUMNS",
        `Record ${index + 2} has ${values.length} values; expected ${headers.length}.`,
      );
    const result = Object.fromEntries(
      headers.map((header, column) => [header, values[column]]),
    ) as CsvRow;
    if (result.csv_format && result.csv_format !== CSV_FORMAT)
      throw new DomainError(
        "CSV_FORMAT",
        `Unsupported format marker in record ${index + 2}.`,
      );
    if (result.csv_format === CSV_FORMAT)
      for (const header of headers as CsvColumn[])
        if (result[header]?.startsWith("'"))
          result[header] = result[header]!.slice(1);
    return result;
  });
  if (!rows.length)
    throw new DomainError(
      "CSV_EMPTY",
      "The CSV has a header but no merchandise rows.",
    );
  return { headers: headers as CsvColumn[], rows };
}
