import net from 'node:net';

/** Ask the OS for any free loopback port. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not allocate a free port')));
      }
    });
  });
}

/** True if the given loopback port can currently be bound. */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * First bindable port in [base, base + range), skipping `exclude`; null if
 * the whole range is taken.
 */
export async function scanForFreePort(
  base: number,
  range: number,
  exclude: Set<number> = new Set(),
): Promise<number | null> {
  for (let port = base; port < base + range; port++) {
    if (exclude.has(port)) continue;
    if (await canBind(port)) return port;
  }
  return null;
}
