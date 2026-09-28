/**
 * Action messages (`/me waves`) without a protocol change.
 *
 * The CTCP convention from IRC is reused: an action is a MESSAGE whose text
 * begins with 0x01 + `ACTION ` and ends with 0x01. Everything else about the
 * envelope — routing, dedup, relay, size limits — is unchanged, so v3 peers
 * render actions as plain text and v4 peers render them properly.
 *
 * Framing note: the receive path checks the framing *before* control-character
 * stripping (which removes 0x01 bytes from arbitrary chat), and after decoding
 * the body is re-sanitised with the marker temporarily restored. Only messages
 * whose 0x01 bytes survive in exactly the CTCP positions are treated as
 * actions; anything else is plain chat.
 */

/** The single control byte framing an action message. */
export const ACTION_BYTE = '\u0001';
const ACTION_PREFIX = `${ACTION_BYTE}ACTION `;
const ACTION_SUFFIX = ACTION_BYTE;

/** True when `text` is a framed action message. */
export function isActionMessage(text: string): boolean {
  return text.startsWith(ACTION_PREFIX) && text.endsWith(ACTION_SUFFIX) && text.length > ACTION_PREFIX.length;
}

/**
 * Frame a user's action text (`waves hello`) for the wire.
 * Returns null when the action is empty after sanitising.
 */
export function encodeActionMessage(text: string): string | null {
  const body = text.trim();
  if (body.length === 0) {
    return null;
  }

  return `${ACTION_PREFIX}${body}${ACTION_SUFFIX}`;
}

/** Extract the action body (`waves hello`) from a framed message. */
export function actionBody(text: string): string {
  return text.slice(ACTION_PREFIX.length, text.length - ACTION_SUFFIX.length);
}

/** Render an action for display: the sender's name becomes the verb's subject. */
export function renderAction(username: string, text: string): string {
  return `* ${username} ${actionBody(text)}`;
}
