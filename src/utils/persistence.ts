import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const writeQueues = new Map<string, Promise<void>>();

/**
 * Crash-safe atomic JSON write using a temporary sibling file + rename,
 * serialized per target path to prevent concurrent write corruption.
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  pretty = true,
  mode?: number
): Promise<void> {
  const resolved = path.resolve(filePath);
  const previous = writeQueues.get(resolved) ?? Promise.resolve();

  const nextTask = previous
    .catch(() => undefined)
    .then(async () => {
      const dir = path.dirname(resolved);
      await fs.mkdir(dir, { recursive: true });
      const tmpPath = `${resolved}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      const payload = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
      try {
        await fs.writeFile(
          tmpPath,
          payload,
          mode !== undefined ? { encoding: 'utf-8', mode } : 'utf-8'
        );
        if (mode !== undefined) {
          await fs.chmod(tmpPath, mode).catch(() => {});
        }
        await fs.rename(tmpPath, resolved);
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => undefined);
        throw err;
      }
    });

  writeQueues.set(resolved, nextTask);
  try {
    await nextTask;
  } finally {
    if (writeQueues.get(resolved) === nextTask) {
      writeQueues.delete(resolved);
    }
  }
}

/**
 * Waits until every queued atomic JSON write has settled.
 *
 * Fire-and-forget persistence (audit log on response `finish`, token usage
 * counters, live-run snapshots) can still be writing into `.state/` after the
 * HTTP response has been delivered. Call this before graceful shutdown or before
 * removing a state directory, otherwise late writes are lost or race the cleanup.
 * Loops because a settling write may enqueue a follow-up write on the same path.
 */
export async function flushPendingWrites(): Promise<void> {
  while (writeQueues.size > 0) {
    await Promise.allSettled([...writeQueues.values()]);
  }
}

const FORMULA_PREFIX_REGEX = /^[=+\-@\t\r]/;

/**
 * RFC 4180 CSV cell serializer with Excel / Power BI formula-injection neutralization.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_PREFIX_REGEX.test(text)) {
    text = `'${text}`;
  }
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}
