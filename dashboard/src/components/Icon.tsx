/**
 * Hand-drawn icon set on a 24px grid, uniform 1.6 stroke.
 * Deliberately not Lucide/Feather — those read as the stock AI choice, and a
 * bespoke set lets every glyph share one stroke weight and terminal style.
 */

export type IconName =
  | "mark"
  | "pulse"
  | "paper"
  | "tray"
  | "globe"
  | "key"
  | "relay"
  | "stencil"
  | "roster"
  | "people"
  | "block"
  | "sliders"
  | "search"
  | "close"
  | "plus"
  | "arrow-out"
  | "copy"
  | "check"
  | "alert"
  | "clip"
  | "reply"
  | "trash"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "list-bullet"
  | "list-number"
  | "quote"
  | "link"
  | "unlink"
  | "clear-format"
  | "code"
  | "format"
  | "info"
  | "history"
  | "star"
  | "star-filled"
  | "archive";

/** Shared by the outline and filled star so the shape cannot drift. */
const STAR_D =
  "m12 4.5 2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.49l-4.7 2.47.9-5.23-3.8-3.7 5.25-.77z";

const paths: Record<IconName, React.ReactNode> = {
  /**
   * The Mittova mark: the envelope flap drawn so it also reads as an M.
   * One idea doing two jobs, and it survives being shrunk to a 16px favicon.
   */
  mark: (
    <>
      <path d="M4 18.6V6.9l8 6.1 8-6.1v11.7" />
      <path d="M2.9 18.6h18.2" />
    </>
  ),
  pulse: <path d="M3 12.5h4l2.5-6 4 12 2.5-6h5" />,
  paper: (
    <>
      <path d="M4 5.5h16v13H4z" />
      <path d="M7.5 10h9M7.5 14h5.5" />
    </>
  ),
  tray: (
    <>
      <path d="M4 13.5h4l1.5 3h5l1.5-3h4" />
      <path d="M5.5 13.5 7 5.5h10l1.5 8v5H5.5z" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.4 3.8 8.5S14.5 18.1 12 20.5c-2.5-2.4-3.8-5.4-3.8-8.5S9.5 5.9 12 3.5Z" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21M18 12v3M15 12v2.5" />
    </>
  ),
  relay: (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="6" cy="17" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M8.2 8.4 15.8 11M8.2 15.6 15.8 13" />
    </>
  ),
  stencil: (
    <>
      <path d="M4.5 4.5h15v6h-15z" />
      <path d="M4.5 13.5h9v6h-9zM16 13.5h3.5v6H16z" />
    </>
  ),
  // A person beside a list: an address book. Contacts.
  roster: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.8-3 2.9-4.5 5.5-4.5S13.7 16 14.5 19" />
      <path d="M16.5 7.5h5M16.5 11h5M16.5 14.5h3" />
    </>
  ),
  // Two figures, the second partial so it reads as depth rather than a crowd:
  // accounts belonging to people, not a directory of them. Users.
  people: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c.9-3.2 3.1-4.9 6-4.9s5.1 1.7 6 4.9" />
      <path d="M15.6 5.3a3.2 3.2 0 0 1 0 5.4" />
      <path d="M17.6 14.5c1.9.7 3.2 2.2 3.9 4.5" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6.2 6.2 11.6 11.6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
      <circle cx="16" cy="8" r="2" />
      <circle cx="10" cy="16" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  "arrow-out": (
    <>
      <path d="M14 5.5h4.5V10" />
      <path d="M18.5 5.5 11 13" />
      <path d="M18 14v4.5H5.5V6H10" />
    </>
  ),
  copy: (
    <>
      <path d="M9 9h10.5v10.5H9z" />
      <path d="M15 9V4.5H4.5V15H9" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4.5 21 19.5H3z" />
      <path d="M12 10v4M12 16.8v.2" />
    </>
  ),
  clip: (
    <path d="M18.7 11.2l-7.4 7.4a4.4 4.4 0 0 1-6.2-6.2l7.8-7.8a2.9 2.9 0 0 1 4.1 4.1l-7.8 7.8a1.45 1.45 0 0 1-2-2l6.9-6.9" />
  ),
  reply: (
    <>
      <path d="M9 7 4.5 11.5 9 16" />
      <path d="M4.5 11.5H14a5.5 5.5 0 0 1 5.5 5.5v1" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.5h5V7" />
      <path d="M6.5 7l1 12.5h9L17.5 7" />
    </>
  ),

  /* ---- editor toolbar: same 24 grid, same 1.6 stroke as everything else ---- */
  bold: (
    <>
      <path d="M7 4.5h5.6a3.75 3.75 0 0 1 0 7.5H7z" />
      <path d="M7 12h6.4a3.75 3.75 0 0 1 0 7.5H7z" />
    </>
  ),
  italic: <path d="M15.5 4.5h-5M13.5 19.5h-5M14 4.5 10 19.5" />,
  underline: (
    <>
      <path d="M7 4.5v6.8a5 5 0 0 0 10 0V4.5" />
      <path d="M5.5 20h13" />
    </>
  ),
  strike: (
    <>
      <path d="M4.5 12h15" />
      <path d="M8 7.2A3.3 3.3 0 0 1 11.4 4.5h1.6a3.2 3.2 0 0 1 3.1 2.4" />
      <path d="M16.2 15A3.4 3.4 0 0 1 12.8 19.5h-1.6A3.4 3.4 0 0 1 7.8 16.6" />
    </>
  ),
  "list-bullet": (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <circle cx="4.6" cy="6.5" r="1.15" />
      <circle cx="4.6" cy="12" r="1.15" />
      <circle cx="4.6" cy="17.5" r="1.15" />
    </>
  ),
  "list-number": (
    <>
      <path d="M11.5 8.2h8.5M11.5 16.2h8.5" />
      <path d="M3.4 5.6 5.2 4.5v5.6" />
      <path d="M3.1 13.7a1.75 1.75 0 1 1 3 1.25L3.1 18.3h3.3" />
    </>
  ),
  quote: (
    <>
      <path d="M5 5.8v12.4" />
      <path d="M9.8 9.6h9.4M9.8 14.4h6.2" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.1 1.1" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.1-1.1" />
    </>
  ),
  unlink: (
    <>
      <path d="M10.5 13.5a3.4 3.4 0 0 0 4.4-.3l1.8-1.8a3.5 3.5 0 0 0-4.9-4.9l-.9.9" />
      <path d="M13.2 10.3a3.4 3.4 0 0 0-4.3.4l-1.8 1.8a3.5 3.5 0 0 0 4.9 4.9l.8-.8" />
      <path d="m4 4 16 16" />
    </>
  ),
  "clear-format": (
    <>
      <path d="M4.5 6.2h10M9.5 6.2v11.6" />
      <path d="m15.6 13.4 5.4 5.4M21 13.4l-5.4 5.4" />
    </>
  ),
  code: <path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4" />,
  /**
   * Indentation, which is what reformatting produces. Deliberately not a wand:
   * this rewrites whitespace by a rule, it does not do anything magic, and the
   * varying indents read differently from the evenly-ragged lines of a list.
   */
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.9v.1" />
    </>
  ),
  /** A clock with its hand wound back: what was, and going back to it. */
  history: (
    <>
      <path d="M3.8 12a8.2 8.2 0 1 0 2.6-6" />
      <path d="M3.5 4.2V9h4.8" />
      <path d="M12 7.8V12l3 1.8" />
    </>
  ),
  format: (
    <>
      <path d="M3.5 5.5h17" />
      <path d="M8 10h12.5" />
      <path d="M11.5 14.5h9" />
      <path d="M3.5 19h17" />
    </>
  ),
  star: <path d={STAR_D} />,
  "star-filled": <path d={STAR_D} fill="currentColor" />,
  archive: (
    <>
      <path d="M3.5 5.5h17v3.5h-17z" />
      <path d="M5 9v9.5h14V9" />
      <path d="M9.8 12.5h4.4" />
    </>
  ),
};

export default function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
