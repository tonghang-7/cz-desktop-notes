const enabled = process.env.NOTES_TRACE === '1';

export function trace(label: string, extra?: string) {
  if (!enabled) return;
  const ms = Math.round(process.uptime() * 1000);
  console.log(`[trace] +${String(ms).padStart(6, ' ')}ms  ${label}${extra ? '  ' + extra : ''}`);
}

export async function measure<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  const t = performance.now();
  const result = await fn();
  if (enabled) {
    const cost = (performance.now() - t).toFixed(1);
    console.log(`[trace] ${label}  ${cost}ms`);
  }
  return result;
}
