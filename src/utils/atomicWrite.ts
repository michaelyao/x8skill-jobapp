import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write a file so a crash can never leave it half-written.
 *
 * Write to a temp file → fsync it → rename over the target → fsync the directory. The rename
 * is atomic on POSIX, so a reader sees either the old file or the new one, never a truncated
 * one. Without this, a crash while saving pending-approvals.json would corrupt the entire
 * approval queue — not one record, all of them — and applications.json is the same story.
 *
 * `durable: false` skips the fsyncs (keeping only the atomic rename) for files written many
 * times a second that can be regenerated, like the worker heartbeat.
 *
 * Caveat worth knowing: on macOS fsync() flushes to the drive's cache, not necessarily to the
 * platter — full durability there needs F_FULLFSYNC, which node does not expose. This closes
 * the process-crash window, which is the realistic one; a sudden power loss is not fully
 * covered on this platform.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  { durable = true }: { durable?: boolean } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(contents, "utf8");
    if (durable) await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }

  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }

  // Persist the directory entry too: without this the rename itself can be lost even though
  // the file's contents were flushed. Best-effort — not every platform allows opening a
  // directory for fsync.
  if (durable) {
    let dirHandle: fs.FileHandle | undefined;
    try {
      dirHandle = await fs.open(dir, "r");
      await dirHandle.sync();
    } catch {
      /* not supported here */
    } finally {
      await dirHandle?.close().catch(() => undefined);
    }
  }
}

/** JSON convenience — same guarantees. */
export async function writeJsonAtomic(filePath: string, value: unknown, opts?: { durable?: boolean }): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, opts);
}
