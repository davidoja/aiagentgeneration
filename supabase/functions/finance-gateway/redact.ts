const SECRET_KEY = /token|secret|password|authorization|refresh|credential|client_secret|client_id/i;

export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  const needles = secrets.filter((secret) => secret.length >= 8);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      let next = node;
      for (const secret of needles) {
        if (next.includes(secret)) {
          next = next.split(secret).join("[redacted]");
        }
      }
      return next;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (SECRET_KEY.test(key)) {
          continue;
        }
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}
