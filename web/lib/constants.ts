/**
 * Values shared with middleware. Middleware runs on the EDGE runtime, where node:crypto does
 * not exist — so this file must never import anything that reaches it. Keeping the cookie
 * name here is what lets middleware gate requests without pulling in the auth module.
 */
export const SESSION_COOKIE = "jobapp_session";
