/**
 * Auth cases for the web console. Pure — no network, no files. Run: npx tsx src/debug/authCases.ts
 */
import { authenticate, canRun, hashPassword, loadUsers, signSession, verifySession } from "../auth/users.js";

let bad = 0;
const check = (name: string, pass: boolean, extra = "") => {
  if (!pass) bad += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const nathanPw = "correct horse battery staple";
const mikePw = "another long passphrase!";
const env = {
  WEB_USER_NATHAN: hashPassword(nathanPw),
  WEB_USER_MIKE: `${hashPassword(mikePw)}:reviewer`,
  WEB_SESSION_SECRET: "x".repeat(40),
} as NodeJS.ProcessEnv;

// --- accounts ---------------------------------------------------------------
const users = loadUsers(env);
check("two accounts load from WEB_USER_*", users.length === 2, JSON.stringify(users.map((u) => `${u.username}:${u.role}`)));
check("role defaults to admin", users.find((u) => u.username === "nathan")?.role === "admin");
check("explicit reviewer role parsed", users.find((u) => u.username === "mike")?.role === "reviewer");

// compact form, and the two forms mixing
const compact = { WEB_USERS: `dana:${hashPassword("dana passphrase here")}:reviewer`, ...env } as NodeJS.ProcessEnv;
check("WEB_USERS compact form works alongside WEB_USER_*", loadUsers(compact).length === 3);

// --- login ------------------------------------------------------------------
check("correct password authenticates", authenticate("nathan", nathanPw, env)?.username === "nathan");
check("username is case-insensitive", authenticate("NATHAN", nathanPw, env)?.username === "nathan");
check("wrong password rejected", authenticate("nathan", "wrong", env) === null);
check("unknown user rejected", authenticate("nobody", nathanPw, env) === null);
check("one user's password does not open another account", authenticate("mike", nathanPw, env) === null);
check("empty password rejected", authenticate("nathan", "", env) === null);
check("no accounts configured → nothing authenticates", authenticate("nathan", nathanPw, {} as NodeJS.ProcessEnv) === null);

// --- sessions ---------------------------------------------------------------
const token = signSession({ username: "nathan", role: "admin" }, 60_000, env)!;
check("valid session verifies", verifySession(token, env)?.username === "nathan");
check("tampered payload rejected", verifySession(`${token.split(".")[0]}x.${token.split(".")[1]}`, env) === null);
check("tampered signature rejected", verifySession(`${token.split(".")[0]}.${token.split(".")[1]}x`, env) === null);
check("session signed with another secret rejected", verifySession(token, { ...env, WEB_SESSION_SECRET: "y".repeat(40) }) === null);
check("expired session rejected", verifySession(signSession({ username: "n", role: "admin" }, -1000, env)!, env) === null);
check("garbage token rejected", verifySession("not-a-token", env) === null);
check("missing session secret → cannot sign", signSession({ username: "n", role: "admin" }, 1000, {} as NodeJS.ProcessEnv) === null);
check("short session secret refused", signSession({ username: "n", role: "admin" }, 1000, { WEB_SESSION_SECRET: "tooshort" } as NodeJS.ProcessEnv) === null);

// --- roles ------------------------------------------------------------------
check("reviewer may approve", canRun("reviewer", "approve"));
check("reviewer may not sweep", !canRun("reviewer", "sweep"));
check("reviewer may not edit answers", !canRun("reviewer", "update_answers"));
check("admin may sweep", canRun("admin", "sweep"));

console.log(bad === 0 ? "\nall auth cases pass" : `\n${bad} case(s) FAILED`);
process.exitCode = bad === 0 ? 0 : 1;
