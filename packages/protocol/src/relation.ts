import type { Relation } from './schemas.js';

/** Fails closed: a missing owner id is never `own`. Computed per recipient at delivery, never stored. Only the same owner is `own`; a human of another account is `other`. */
export const relationOf = (senderOwnerId: string, recipientOwnerId: string, senderKind: 'agent' | 'human' | 'system'): Relation =>
  senderKind === 'system' ? 'system' : !senderOwnerId || !recipientOwnerId ? 'other' : senderOwnerId === recipientOwnerId ? 'own' : 'other';
