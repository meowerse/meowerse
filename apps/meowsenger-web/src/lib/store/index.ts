import { purge as purgeConversation } from "./conversationCache";
import { purge as purgeMembers } from "./memberCache";
import { removeChat, subscribeRemoved } from "./chatListStore";

/** Remove a chat from every cache (revoked, left, or gone from the list). */
export function purgeChat(chatId: string): void {
  purgeConversation(chatId);
  purgeMembers(chatId);
  removeChat(chatId);
}
// A chat that disappears from an applied list is purged everywhere.
subscribeRemoved(purgeChat);

export { setScope, clearAll, begin, isCurrent, getScope, getEpoch, subscribe, useStore, type Token } from "./scope";
export { installAuthChannel, broadcastLogout } from "./authChannel";
export * as conversationCache from "./conversationCache";
export * as memberCache from "./memberCache";
export * as chatListStore from "./chatListStore";
export type { ConversationEntry, ScrollAnchor } from "./conversationCache";
