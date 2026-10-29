/** Original, code-native JK wordmark created for this application. */
export function Brand({light = false, compact = false}: {light?: boolean; compact?: boolean}) {
  return <span className={`jk-brand ${light ? 'jk-brand-light' : ''} ${compact ? 'jk-brand-compact' : ''}`}>
    <svg className="jk-brand-mark" width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <rect width="44" height="44" rx="12" fill="currentColor"/>
      <path d="M18 12v15a5 5 0 0 1-10 0v-2M24 12v20m12-20L25 22l11 10" stroke="var(--jk-logo-ink, white)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m35 5 1 2.5L38.5 9 36 10l-1 2.5L34 10l-2.5-1 2.5-1.5L35 5Z" fill="var(--jk-logo-ink, white)"/>
    </svg>
    {!compact && <span className="jk-brand-type"><strong>Lava Rápido JK</strong><span>CUIDADO EM CADA DETALHE</span></span>}
  </span>;
}
