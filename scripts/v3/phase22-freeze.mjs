/** Deep-freeze a value in place; shared by committed-generation readers and producers. */
export function freezePhase22Value(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezePhase22Value(child, seen);
    Object.freeze(value);
  }
  return value;
}
