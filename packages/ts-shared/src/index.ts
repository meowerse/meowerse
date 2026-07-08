export { slugify } from "./slugify";

/** Max length (chars) of a chat message body. Single source of truth shared by the
 *  Conversation DO (live `send`/`edit`) and the REST forward handler, so the two
 *  can never drift out of sync on what counts as an over-long body. */
export const MAX_MESSAGE_BODY = 4000;
