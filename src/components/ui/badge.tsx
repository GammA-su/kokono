import type { LineupStatus } from "@/generated/prisma/enums";

export const statusLabels: Record<LineupStatus, string> = {
  ANNOUNCED: "Announced",
  PREORDER: "Preorder",
  RELEASED: "Released",
  DISCONTINUED: "Discontinued",
  UNKNOWN: "Unknown",
};
export function StatusBadge({ status }: { status: LineupStatus }) {
  return (
    <span className={`badge status-${status.toLowerCase()}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}
