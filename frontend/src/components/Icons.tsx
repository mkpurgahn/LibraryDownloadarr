interface IconProps {
  className?: string;
}

const iconClass = (className?: string) =>
  `fill-none stroke-current stroke-2 ${className || 'h-5 w-5'}`;

export function HomeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="m3 11 9-8 9 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HistoryIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3v5h5M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DocumentIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="M6 3h9l3 3v15H6z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 3v4h4M9 12h6M9 16h6" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FilmIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9h4m10 0h4M3 15h4m10 0h4" />
    </svg>
  );
}

export function TvIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="m8 3 4 3 4-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MusicIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="M9 18V6l10-2v12" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="M3 6h7l2 2h9v11H3z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="M20 7v5h-5M4 17v-5h5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.1 8A7 7 0 0 1 18 7l2 5M18 16a7 7 0 0 1-11.9 1L4 12" strokeLinecap="round" />
    </svg>
  );
}

export function LockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="m9 7 8 5-8 5V7Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={iconClass(className)}>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
