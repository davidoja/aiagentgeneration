function same(actual: unknown, expected: unknown): boolean {
  if (actual === expected) {
    return true;
  }
  if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) {
    return false;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      return false;
    }
    return actual.every((item, index) => same(item, expected[index]));
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  if (actualKeys.length !== expectedKeys.length) {
    return false;
  }
  return actualKeys.every((key) => same(actualRecord[key], expectedRecord[key]));
}

export function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (!same(actual, expected)) {
    const prefix = message ? `${message}: ` : "";
    throw new Error(`${prefix}${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

export function assertNotEquals(actual: unknown, expected: unknown, message?: string): void {
  if (same(actual, expected)) {
    const prefix = message ? `${message}: ` : "";
    throw new Error(`${prefix}expected values to differ: ${JSON.stringify(actual)}`);
  }
}

export function assertOk(value: unknown, message?: string): asserts value {
  if (!value) {
    throw new Error(message ?? `expected truthy value, got ${JSON.stringify(value)}`);
  }
}
