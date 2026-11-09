import type { SVGProps } from "react";

/** Symbole aus dem Design-Guide (11.6): 24er Raster, Linie 1.8, runde Enden, Farbe = currentColor. */
const paths = {
  home: "M3 11l9-8 9 8M5 10v10h14V10",
  people:
    "M12.5 8a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.7a3.5 3.5 0 010 6.6M18 14.3c2 .7 3.5 2.6 3.5 5.7",
  user: "M16 8a4 4 0 11-8 0 4 4 0 018 0zM4 21c0-4 3.6-7 8-7s8 3 8 7",
  building: "M5 3h14v18H5zM9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3",
  invoice: "M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h7",
  book: "M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h11",
  chart: "M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3",
  mail: "M3 7l9 6 9-6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z",
  calendar:
    "M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM3 10h18M8 3v4M16 3v4",
  gear: "M15 12a3 3 0 11-6 0 3 3 0 016 0zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
  plus: "M12 5v14M5 12h14",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  arrowRight: "M4 12h16M14 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  search: "M17.5 11a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0zM16 16l5 5",
  warning: "M12 3l10 18H2zM12 10v5M12 18v.5",
  info: "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM12 11v6M12 7.5v.5",
  check: "M5 12.5l4.5 4.5L19 7",
  lock: "M7 11h10a2 2 0 012 2v6a2 2 0 01-2 2H7a2 2 0 01-2-2v-6a2 2 0 012-2zM8 11V8a4 4 0 018 0v3",
  key: "M12 15a4 4 0 11-8 0 4 4 0 018 0zM11 12l9-9M16 7l3 3",
  download: "M12 4v11M7 11l5 5 5-5M4 20h16",
  attach: "M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7",
  ban: "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM5.6 5.6l12.8 12.8",
  upload: "M12 16V5M7 9l5-5 5 5M4 20h16",
  refresh: "M20 11a8 8 0 00-14-4M4 4v4h4M4 13a8 8 0 0014 4M20 20v-4h-4",
  copy: "M10 8h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2zM4 16V6a2 2 0 012-2h10",
  undo: "M9 8L4 13l5 5M4 13h10a6 6 0 010 12",
  save: "M5 3h12l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM15 12a3 3 0 11-6 0 3 3 0 016 0z",
  edit: "M4 20l1-5L16 4l4 4L9 19z",
  print: "M7 9V3h10v6M4 9h16v8H4zM7 14h10v7H7z",
  send: "M3 11l18-8-8 18-2-8z",
  sun: "M16 12a4 4 0 11-8 0 4 4 0 018 0zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z",
  logout: "M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 8l4 4-4 4M19 12H9",
  keyboard:
    "M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1zM7 10h.5M11 10h.5M15 10h.5M7 14h10",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.5M3 12h.5M3 18h.5",
  link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
  merge: "M6 4v6a6 6 0 006 6h6M18 12l3 4-3 4M6 20V10",
  block: "M21 12a9 9 0 11-18 0 9 9 0 0118 0zM5.6 5.6l12.8 12.8",
} as const;

export type IconName = keyof typeof paths;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

/** Dekoratives Symbol. Bedeutung gehört in sichtbaren Text oder in ein aria-label am Button. */
export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="icon"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
