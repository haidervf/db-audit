/** Minimal inline stroke icons (16px grid). No icon font or external assets. */
const PATHS: Record<string, string> = {
  overview: 'M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z',
  procedure: 'M5 3.5 2 8l3 4.5M11 3.5 14 8l-3 4.5M9.5 2.5l-3 11',
  table: 'M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.8h11M6.5 6.5V13',
  view: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  function: 'M10.5 2.5c-1.8 0-2.6.8-2.9 2.6L6.4 11c-.3 1.6-1 2.5-2.9 2.5M4.5 6.5h6',
  trigger: 'M9 1.8 3.5 9h4l-1 5.2L12.5 7h-4z',
  job: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.8V8l2.3 1.5',
  graph: 'M4 5.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM12 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM4 14a1.8 1.8 0 1 0 0-3.6A1.8 1.8 0 0 0 4 14zM5.6 4.6 10.4 7.2M5.6 11.4l4.8-2.6',
  settings: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM13 8a5 5 0 0 0-.1-1l1.4-1.1-1.3-2.3-1.7.6a5 5 0 0 0-1.7-1L9.3 1.5H6.7l-.3 1.7a5 5 0 0 0-1.7 1l-1.7-.6-1.3 2.3L3.1 7a5 5 0 0 0 0 2l-1.4 1.1L3 12.4l1.7-.6a5 5 0 0 0 1.7 1l.3 1.7h2.6l.3-1.7a5 5 0 0 0 1.7-1l1.7.6 1.3-2.3L12.9 9c.1-.3.1-.7.1-1z',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.4-3.4',
  refresh: 'M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3.2h-3.2',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  chevronsUpDown: 'M5 6 8 3l3 3M5 10l3 3 3-3',
  plus: 'M8 3v10M3 8h10',
  check: 'M3 8.5 6.5 12 13 4.5',
  x: 'M4 4l8 8M12 4l-8 8',
  alert: 'M8 2 1.5 13.5h13zM8 6.5v3.2M8 11.6v.1',
  info: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 7.3v4M8 4.9v.1',
  external: 'M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4',
  sun: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3',
  moon: 'M13.5 9.5A5.8 5.8 0 0 1 6.5 2.5a5.8 5.8 0 1 0 7 7z',
  database: 'M8 5.2c3 0 5.5-.8 5.5-1.8S11 1.6 8 1.6 2.5 2.4 2.5 3.4 5 5.2 8 5.2zM2.5 3.4v9.2c0 1 2.5 1.8 5.5 1.8s5.5-.8 5.5-1.8V3.4M2.5 8c0 1 2.5 1.8 5.5 1.8s5.5-.8 5.5-1.8',
  sparkles: 'M7 2.5 8.2 6 11.5 7.2 8.2 8.4 7 12 5.8 8.4 2.5 7.2 5.8 6zM12.5 10.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z',
  play: 'M5 3.2v9.6L12.5 8z',
  trash: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9',
  edit: 'M10.5 2.5l3 3-8 8h-3v-3z',
  link: 'M6.5 9.5l3-3M7.2 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.8 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1',
  focus: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  arrowDown: 'M8 2.5v11M3.5 9 8 13.5 12.5 9',
  arrowRight: 'M2.5 8h11M9 3.5 13.5 8 9 12.5',
  key: 'M10 9.5a3.5 3.5 0 1 0-3.4-2.7L2 11.4V14h2.6v-1.6h1.6v-1.6h1.4l1-.9c.4.1.9.1 1.4-.4zM11 5.5v.1',
  lock: 'M4 7.5h8v6.5H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  layers: 'M8 2 1.5 5.5 8 9l6.5-3.5zM1.5 8.5 8 12l6.5-3.5M1.5 11.3 8 14.8l6.5-3.5',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.8V8l2.3 1.5',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, title }: { name: IconName | string; size?: number; className?: string; title?: string }) {
  const d = PATHS[name] ?? PATHS.info;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
