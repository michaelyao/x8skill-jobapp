import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

/**
 * AUTHENTICATION THAT NEEDS A HUMAN, said out loud.
 *
 * Every Workday employer is a separate tenant with its own candidate account. When neither
 * creating nor signing in works, and the email that would rescue it never arrives, there is
 * nothing the automation can do — someone has to open that tenant and make an account.
 *
 * Sixty-five applications reached exactly that point and said nothing anyone would see: a line in
 * worker.log, a record filed under "filled, not sent", and no signal that the whole Workday half
 * of the list was stuck behind one solvable thing. An alarm is the difference between "the queue
 * is quiet today" and "sixty-five jobs are waiting on you to create an account".
 *
 * One file, written by the worker and read by the website, the same arrangement as ocr-health.json
 * — so what the page shows and what the worker believes cannot drift apart.
 */
export interface AuthAlert {
  /** The tenant's host, which is what identifies a Workday account boundary. */
  tenant: string;
  /** Which step ran out of options: creating, signing in, or waiting for an email. */
  stage: "create" | "signin" | "activation-email" | "reset-email";
  /** The tenant's own words, so the alarm is evidence rather than a summary. */
  detail: string;
  email: string;
  jobCode?: string;
  company?: string;
  at: string;
  /** How many jobs have hit this same tenant. One account fixes all of them. */
  hits: number;
}

const ALERTS_PATH = path.join(DATA_DIR, "auth-alerts.json");

export async function readAuthAlerts(): Promise<AuthAlert[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(ALERTS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as AuthAlert[]) : [];
  } catch {
    return [];
  }
}

/**
 * Record one, keyed on TENANT — not on the job. Twelve postings at the same employer are one
 * account to create, and twelve identical alarms would bury the eleven other tenants that also
 * need one.
 */
export async function recordAuthAlert(alert: Omit<AuthAlert, "at" | "hits">): Promise<void> {
  const alerts = await readAuthAlerts();
  const existing = alerts.find((a) => a.tenant === alert.tenant);
  const now = new Date().toISOString();
  if (existing) {
    existing.hits += 1;
    existing.at = now;
    existing.stage = alert.stage;
    existing.detail = alert.detail;
    if (alert.jobCode) existing.jobCode = alert.jobCode;
  } else {
    alerts.push({ ...alert, at: now, hits: 1 });
  }
  const tmp = `${ALERTS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(alerts, null, 2), "utf8");
  await fs.rename(tmp, ALERTS_PATH);
}

/** Cleared when a tenant finally lets us in, so a fixed account stops shouting. */
export async function clearAuthAlert(tenant: string): Promise<void> {
  const alerts = await readAuthAlerts();
  const left = alerts.filter((a) => a.tenant !== tenant);
  if (left.length === alerts.length) return;
  const tmp = `${ALERTS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(left, null, 2), "utf8");
  await fs.rename(tmp, ALERTS_PATH);
}
