import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../server.ts';

/**
 * Snapshot of the full Express route table: method, path and middleware chain, in order.
 * Guards refactors (e.g. splitting server.ts into routers): any added, removed, reordered or
 * differently protected route changes the snapshot and must be reviewed on purpose.
 * Update with: npx vitest run tests/route_table.test.ts -u
 */
interface Layer {
  name: string;
  regexp?: RegExp;
  route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] };
  handle?: { stack?: Layer[] };
}

function describeStack(stack: Layer[], indent: string, out: string[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      const chain = layer.route.stack.map((s) => s.name || 'anonymous').join(' > ');
      out.push(`${indent}${methods} ${layer.route.path}  [${chain}]`);
    } else if (layer.handle?.stack) {
      out.push(`${indent}ROUTER ${String(layer.regexp)}`);
      describeStack(layer.handle.stack, `${indent}  `, out);
    } else {
      out.push(`${indent}USE ${layer.name} ${String(layer.regexp)}`);
    }
  }
}

it('keeps the HTTP route table and middleware chains stable', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-route-table-'));
  const { app, drainPendingWrites } = await createApp({ rootDir: tmpDir, mountFrontend: false });
  const lines: string[] = [];
  describeStack((app as unknown as { _router: { stack: Layer[] } })._router.stack, '', lines);
  await drainPendingWrites();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot('./__snapshots__/route-table.txt');
});
