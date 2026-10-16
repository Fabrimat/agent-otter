// Text hygiene: pure functions. Everything a participant declares or writes passes through here before storage or delivery.

export const IDENT_MAX = 32;

// Control, format (bidi, zero-width, tag chars), line/paragraph separators, variation selectors and invisible fillers.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u180B-\u180D\u180F]/gu;

/** Strips invisible/control characters and trims. `multiline` keeps \n and \t. */
export const sanitizeText = (s: unknown, multiline = false): string =>
  String(s ?? '').replace(INVISIBLE, (c) => (multiline && (c === '\n' || c === '\t') ? c : '')).trim();

/** Display names, vendors, ids: only [\p{L}\p{N}_.-], so they cannot forge envelope headers. */
export const sanitizeIdent = (s: unknown, max = IDENT_MAX): string =>
  [...sanitizeText(s).replace(/[^\p{L}\p{N}_.-]+/gu, '_')].slice(0, max).join('');

// ponytail: small hand-made map (Cyrillic/Greek lookalikes), not the full Unicode confusables table; extend when a real bypass shows up.
const CONFUSABLES: Record<string, string> = {
  ı: 'i', а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
  α: 'a', ε: 'e', ι: 'i', ο: 'o', ρ: 'p', τ: 't', υ: 'u', ν: 'v', χ: 'x', κ: 'k', β: 'b', η: 'n', μ: 'u',
};

/** Per-room name dedupe key: NFKC, case fold, lookalike letters mapped to Latin. */
export const skeleton = (s: string): string =>
  [...s.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()].map((c) => CONFUSABLES[c] ?? c).join('');

export const RESERVED_NAMES: readonly string[] = ['system', 'admin', 'human', 'moderator', 'host', 'claude-code', 'claude', 'codex', 'opencode', 'hermes'];
const bare = (s: string) => skeleton(s).replace(/[_.-]/g, '');
const RESERVED = new Set(RESERVED_NAMES.map(bare));

/** True if the name (after sanitising) equals a reserved name, ignoring case, accents, lookalikes, separators and trailing digits ("system-2"). */
export const isReservedName = (name: string): boolean => {
  const k = bare(sanitizeIdent(name));
  return RESERVED.has(k) || RESERVED.has(k.replace(/\d+$/, ''));
};
