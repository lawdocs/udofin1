import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

export interface RunningPortal {
  origin: string;
  stop(): Promise<void>;
  output(): string;
}

/** Starts a built portal (`pnpm --filter <app> build` first) with test configuration. */
export async function startPortal(
  app: 'ops-portal' | 'lender-portal',
  port: number,
  env: Record<string, string>,
): Promise<RunningPortal> {
  const logs: string[] = [];
  const child: ChildProcess = spawn(
    'node',
    [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--port', String(port)],
    {
      cwd: join(ROOT, 'apps', app),
      env: { ...process.env, NODE_ENV: 'production', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
  const origin = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/login`, { redirect: 'manual' });
      if (res.status > 0) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error(`portal did not start:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    origin,
    output: () => logs.join(''),
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  };
}

export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
