// The account pages' shared wording: a platform's error code in Romanian, and a count of trades.

/** `who`: „exchange-ul” or „brokerul”. */
export const codeRo = (code: string, who: string): string =>
  ({
    AUTH: 'cheia API e invalidă sau a expirat',
    PERMISSION: 'cheia nu are permisiunea necesară (sau IP-ul nu e pe lista permisă)',
    RATE_LIMIT: `${who} limitează temporar cererile (prea multe cereri sau supraîncărcare); reîncerc automat`,
    NETWORK: 'problemă de rețea',
    MAINTENANCE: `${who} e în mentenanță sau nu răspunde`,
    EXCHANGE: `eroare de la ${who.replace(/-?ul$/, '')}`,
  })[code] ?? `eroare de la ${who.replace(/-?ul$/, '')}`;

/** Codes whose raw exchange text helps (a wrong key, a missing permission, an unknown error); the rest are explained above. */
export const SHOW_RAW = new Set(['AUTH', 'PERMISSION', 'EXCHANGE']);

/** „1 tranzacție”, „5 tranzacții”, „20 de tranzacții”. */
export const tradesRo = (n: number): string => (n === 1 ? '1 tranzacție' : `${n}${n % 100 >= 20 || (n > 0 && n % 100 === 0) ? ' de' : ''} tranzacții`);
