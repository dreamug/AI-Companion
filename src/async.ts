/** Release the caller even when an adapter fails to settle after cancellation. */
export async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  let cancel = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const listener = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", listener, { once: true });
    cancel = () => signal.removeEventListener("abort", listener);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    cancel();
  }
}
