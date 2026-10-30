/** The meowerse auth account page (auth-web `/account`). It lives on the auth origin, not
 *  the BFF, so it is kept out of meowsengerApi (which several tests mock wholesale). */
export const AUTH_ORIGIN = "https://auth.alxnko.dev";
export function accountUrl(): string { return `${AUTH_ORIGIN}/account`; }
