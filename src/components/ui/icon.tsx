import type { CSSProperties } from "react";

const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  flag: "M5 21V4m0 0c5-5 9 5 14 0v11c-5 5-9-5-14 0",
  layers: "m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  tag: "M3 3h8l10 10-8 8L3 11V3Zm4 4h.01",
  box: "m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M7 5.8l9 5",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  arrow: "m9 5 7 7-7 7",
  link: "M14 3h7v7m0-7L10 14m1-10H4v16h16v-7",
  image: "M3 3h18v18H3zM3 17l6-6 5 5 3-3 4 4M15 7h.01",
  logout: "M9 4H3v16h6m5-13 5 5-5 5m-7-5h12",
  check: "m5 12 4 4L19 6",
} as const;
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
