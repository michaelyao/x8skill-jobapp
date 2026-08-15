#!/usr/bin/env node
/**
 * Print a .env line for a console account. The password is read with echo off and is never
 * written to disk, never logged, and never passed as an argument (argv is visible to `ps`).
 *
 *   npm run hash-password
 *
 * Paste the printed line into .env. Repeat for each user.
 */
import readline from "node:readline";
import { hashPassword } from "../src/auth/users.ts";

const ask = (query, { hidden = false } = {}) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Suppress echo: swallow the output writes while the answer is being typed.
      const onData = (char) => {
        if (["\n", "\r", ""].includes(char.toString())) process.stdin.removeListener("data", onData);
        else process.stdout.write("[2K[200D" + query + "*".repeat(rl.line.length));
      };
      process.stdin.on("data", onData);
    }
    rl.question(query, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });

const username = (await ask("username (letters, digits, _ or -): ")).trim().toLowerCase();
if (!/^[a-z0-9_-]+$/.test(username)) {
  console.error("Username must match [a-z0-9_-]+ — it becomes part of an env var name.");
  process.exit(1);
}

const password = await ask("password: ", { hidden: true });
if (password.length < 12) {
  console.error(`Password is ${password.length} characters. Use at least 12 — this console can submit real applications.`);
  process.exit(1);
}
const again = await ask("confirm password: ", { hidden: true });
if (password !== again) {
  console.error("Passwords do not match.");
  process.exit(1);
}

const roleAnswer = (await ask("role [admin]/reviewer: ")).trim().toLowerCase();
const role = roleAnswer === "reviewer" ? "reviewer" : "admin";

const stored = hashPassword(password);
const envKey = `WEB_USER_${username.toUpperCase().replace(/-/g, "_")}`;

console.log("\nAdd this line to .env:\n");
console.log(`${envKey}=${role === "admin" ? stored : `${stored}:reviewer`}`);
console.log("\nAnd, once, a session secret (any 32+ random chars):");
console.log(`WEB_SESSION_SECRET=${(await import("node:crypto")).randomBytes(32).toString("base64url")}`);
console.log("\nreviewer = approve/skip/change only; admin also sweeps, refreshes the list and edits answers.");
