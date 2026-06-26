/**
 * The canonical string the auth-bot HMAC-signs and the auth worker verifies for
 * the internal Telegram confirm callback (spec §6). Lives in shared code so the
 * two sides can NEVER drift — a mismatch would silently break verification.
 * Order and separator are part of the contract.
 */
export interface InternalConfirmFields {
  nonce: string;
  telegramId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  ts: string;
}

export function internalConfirmString(p: InternalConfirmFields): string {
  return [p.nonce, p.telegramId, p.username, p.displayName, p.avatarUrl, p.ts].join("\n");
}
