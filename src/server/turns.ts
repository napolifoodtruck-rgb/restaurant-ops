/** One at a time per key, inside this server only. Before running more than one server, see docs/scaling.md. */
/**
 * Taking turns: work that reads something, changes it and writes it back runs one at a time per key,
 * so two requests a moment apart can't both read the same thing and lose one change. One app server,
 * so an in-process queue does it (several servers would need a database lock instead).
 */
const queues = new Map<string, Promise<unknown>>();

export function inTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  // Forget the key once nothing is waiting behind this one.
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}
