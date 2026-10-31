/** Should this keydown submit (send/save) rather than insert a newline?
 *
 *  - IME guard: while a composition is open (CJK, Cyrillic phonetic, etc.) Enter
 *    confirms the candidate and must NOT send. `isComposing` covers modern browsers;
 *    `keyCode === 229` covers Safari, which fires the keydown after compositionend.
 *  - Desktop: Enter submits, Shift+Enter inserts a newline.
 *  - Touch / coarse pointer: Enter inserts a newline (the send button submits). */
export function enterSubmits(e: {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (e.key !== "Enter") return false;
  if (e.nativeEvent?.isComposing || e.keyCode === 229) return false;
  if (e.shiftKey) return false;
  if (isTouchPrimary()) return false;
  return true;
}

function isTouchPrimary(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}
