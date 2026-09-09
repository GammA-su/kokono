import { z } from "zod";

export const MAX_BULK_ITEMS = 1000;
export const selectionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("explicit"),
      ids: z.array(z.uuid()).max(MAX_BULK_ITEMS),
    })
    .strict(),
  z
    .object({
      mode: z.literal("lineup"),
      lineupId: z.uuid(),
      excludedIds: z.array(z.uuid()).max(MAX_BULK_ITEMS),
    })
    .strict(),
]);
export type Selection = z.infer<typeof selectionSchema>;
export const emptySelection = (): Selection => ({ mode: "explicit", ids: [] });
export function isSelected(selection: Selection, id: string) {
  return selection.mode === "lineup"
    ? !selection.excludedIds.includes(id)
    : selection.ids.includes(id);
}
export function selectItems(
  selection: Selection,
  ids: string[],
  checked: boolean,
): Selection {
  if (selection.mode === "lineup") {
    const excluded = new Set(selection.excludedIds);
    ids.forEach((id) => (checked ? excluded.delete(id) : excluded.add(id)));
    return { ...selection, excludedIds: [...excluded] };
  }
  const selected = new Set(selection.ids);
  ids.forEach((id) => (checked ? selected.add(id) : selected.delete(id)));
  return { mode: "explicit", ids: [...selected] };
}
export function selectionCount(selection: Selection, lineupTotal: number) {
  return selection.mode === "lineup"
    ? Math.max(0, lineupTotal - selection.excludedIds.length)
    : selection.ids.length;
}

export const actionLabels = {
  receive: "Receive stock",
  transfer: "Transfer stock",
  adjust: "Adjust stock",
  watch: "Create/update PurchaseWatch",
  "disable-watch": "Disable PurchaseWatch",
  publish: "Publish to Store",
  unpublish: "Unpublish",
  price: "Set selling price",
  category: "Set category",
  feature: "Mark featured",
  unfeature: "Unmark featured",
  export: "Export selected",
  archive: "Archive",
} as const;
export type BulkAction = keyof typeof actionLabels;
export const bulkActionSchema = z.enum(
  Object.keys(actionLabels) as [BulkAction, ...BulkAction[]],
);
