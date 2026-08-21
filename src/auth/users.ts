import crypto from "node:crypto";

/**
 * Multi-user auth for the web website.
 *
 * Credentials live in .env as scrypt hashes — never plaintext, and never in the repo. The
 * .env parser (src/utils/env.ts) splits on the first "=", strips surrounding quotes and does
 * no escape handling, so the encoding here is deliberately free of spaces and quotes.
 *
 * Two accepted forms, both may be mixed:
 *
 *   WEB_USER_NATHAN=scrypt:<saltHex>:<hashHex>[:role]      ← preferred, one line per user
 *   WEB_USERS=nathan:scrypt:<saltHex>:<hashHex>[:role],mike:scrypt:...   ← compact
 *
 * Roles: "admin" (default) can do everything; "reviewer" can approve/skip/change but cannot
 * start sweeps, refresh the job list, or edit the answer store — the actions that affect
 * every future application rather than one job.
 *
 * Generate a line with:  npm run hash-password
 */

export type Role = "admin" | "reviewer";

export interface User {
  username: string;
  role: Role;
}

interface StoredUser extends User {
  saltHex: string;
  hashHex: string;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

/** Hash a password for .env. Returns "scrypt:<saltHex>:<hashHex>". */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Constant-time password check against a stored "scrypt:salt:hash" value. */
export function verifyPassword(plain: string, saltHex: string, hashHex: string): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT.keylen) return false;
  const actual = crypto.scryptSync(plain, Buffer.from(saltHex, "hex"), SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return crypto.timingSafeEqual(actual, expected);
}

const asRole = (value: string | undefined): Role => (value === "reviewer" ? "reviewer" : "admin");

function parseStored(username: string, value: string): StoredUser | null {
  // value: scrypt:<saltHex>:<hashHex>[:role]
  const parts = value.split(":");
  if (parts.length < 3 || parts[0] !== "scrypt") return null;
  const [, saltHex, hashHex, role] = parts;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  return { username: username.toLowerCase(), role: asRole(role), saltHex, hashHex };
}

/** Every configured account. Empty means the website is unusable — fail closed, never open. */
export function loadUsers(env: NodeJS.ProcessEnv = process.env): StoredUser[] {
  const users = new Map<string, StoredUser>();

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("WEB_USER_") || !value) continue;
    const parsed = parseStored(key.slice("WEB_USER_".length), value);
    if (parsed) users.set(parsed.username, parsed);
  }

  for (const chunk of (env.WEB_USERS ?? "").split(",")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const parsed = parseStored(trimmed.slice(0, idx), trimmed.slice(idx + 1));
    if (parsed) users.set(parsed.username, parsed);
  }

  return [...users.values()];
}

/**
 * Check a login. Returns the user or null — deliberately the same null for "no such user" and
 * "wrong password", and it does the scrypt work either way so the response time does not
 * reveal whether a username exists.
 */
export function authenticate(username: string, password: string, env: NodeJS.ProcessEnv = process.env): User | null {
  const users = loadUsers(env);
  const found = users.find((u) => u.username === username.trim().toLowerCase());
  // Burn equivalent work on a dummy hash when the user is unknown.
  const target = found ?? {
    username: "",
    role: "reviewer" as Role,
    saltHex: "00".repeat(16),
    hashHex: "00".repeat(SCRYPT.keylen),
  };
  const ok = verifyPassword(password, target.saltHex, target.hashHex);
  return ok && found ? { username: found.username, role: found.role } : null;
}

// ---------------------------------------------------------------------------
// Sessions: a signed cookie, no server-side store.
// ---------------------------------------------------------------------------

export interface SessionPayload extends User {
  exp: number; // epoch ms
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

function secret(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.WEB_SESSION_SECRET;
  // A short or missing secret is a configuration error, not something to paper over with a
  // random per-boot key: that would silently log everyone out on every restart.
  return value && value.length >= 32 ? value : null;
}

export function signSession(user: User, ttlMs = 30 * 24 * 60 * 60 * 1000, env = process.env): string | null {
  const key = secret(env);
  if (!key) return null;
  const payload: SessionPayload = { username: user.username, role: user.role, exp: Date.now() + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac("sha256", key).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined, env = process.env): SessionPayload | null {
  const key = secret(env);
  if (!key || !token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(crypto.createHmac("sha256", key).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (!payload.username || payload.exp < Date.now()) return null;
    return { username: payload.username, role: asRole(payload.role), exp: payload.exp };
  } catch {
    return null;
  }
}

/** Actions that change behaviour for every future application, not just one job. */
const ADMIN_ONLY = new Set(["sweep", "refresh_list", "update_answers"]);

export function canRun(role: Role, commandName: string): boolean {
  return role === "admin" || !ADMIN_ONLY.has(commandName);
}
