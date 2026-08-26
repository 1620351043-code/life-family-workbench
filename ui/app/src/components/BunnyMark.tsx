export function BunnyMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return <svg className={`bunny-mark-svg ${className}`.trim()} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Life 小兔子">
    <ellipse cx="22" cy="17" rx="8" ry="15" fill="#fff7fb" stroke="#d9b7dd" strokeWidth="2" transform="rotate(-12 22 17)" />
    <ellipse cx="42" cy="17" rx="8" ry="15" fill="#fff7fb" stroke="#d9b7dd" strokeWidth="2" transform="rotate(12 42 17)" />
    <ellipse cx="22" cy="18" rx="3" ry="9" fill="#f3a5b7" transform="rotate(-12 22 18)" />
    <ellipse cx="42" cy="18" rx="3" ry="9" fill="#f3a5b7" transform="rotate(12 42 18)" />
    <circle cx="32" cy="37" r="20" fill="#fffafc" stroke="#d9b7dd" strokeWidth="2" />
    <circle cx="25" cy="35" r="4" fill="#4e3a73" /><circle cx="39" cy="35" r="4" fill="#4e3a73" />
    <circle cx="24" cy="34" r="1.5" fill="#fff" /><circle cx="38" cy="34" r="1.5" fill="#fff" />
    <path d="M29 42 Q32 45 35 42" fill="none" stroke="#e68b9f" strokeWidth="2" strokeLinecap="round" />
    <path d="M15 52 Q32 59 49 52" fill="none" stroke="#7c74ed" strokeWidth="6" strokeLinecap="round" opacity=".9" />
  </svg>;
}
