const SENSITIVE_FIELD =
  /(token|password|secret|api[_-]?key|authorization|cookie|credential)/iu;

/** Redact credentials embedded in error messages, URLs, stacks, and log text. */
export function redactLogString(value: string): string {
  if (!value) return value;
  return value
    .replace(
      /(https?:\/\/api\.telegram\.org\/bot)\d+:[A-Za-z0-9_-]{16,}/giu,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/giu, '$1[REDACTED]$2')
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/gu, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/gu, '[REDACTED]')
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/gu, '[REDACTED]')
    .replace(/\bplat_[A-Za-z0-9_-]{16,}/gu, '[REDACTED]')
    .replace(/\bxox[abeprs]-[A-Za-z0-9-]{10,}/gu, '[REDACTED]')
    .replace(
      /((?:x-relay-api-key|api[_-]?key|x-api-key|auth[_-]?token|access[_-]?token|password|secret|cookie)\s*[:=]\s*)[^\s,;&]+/giu,
      '$1[REDACTED]',
    );
}

/** Convert arbitrary log metadata (including Error/cause) to a safe value. */
export function sanitizeLogValue(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 8) return '[truncated]';
    if (typeof current === 'string') return redactLogString(current);
    if (
      current == null ||
      typeof current === 'number' ||
      typeof current === 'boolean' ||
      typeof current === 'bigint'
    ) {
      return current;
    }
    if (typeof current !== 'object') return String(current);
    if (seen.has(current)) return '[circular]';
    seen.add(current);

    if (current instanceof Error) {
      const error = current as Error & {
        code?: unknown;
        cause?: unknown;
        error?: unknown;
      };
      const output: Record<string, unknown> = {
        type: error.name,
        message: redactLogString(error.message),
        stack: error.stack ? redactLogString(error.stack) : undefined,
      };
      if (error.code !== undefined)
        output['code'] = visit(error.code, depth + 1);
      if (error.cause !== undefined)
        output['cause'] = visit(error.cause, depth + 1);
      if (error.error !== undefined)
        output['error'] = visit(error.error, depth + 1);
      for (const [key, child] of Object.entries(error)) {
        if (key in output) continue;
        output[key] = SENSITIVE_FIELD.test(key)
          ? '[REDACTED]'
          : visit(child, depth + 1);
      }
      return output;
    }

    if (Array.isArray(current)) {
      return current.slice(0, 100).map((item) => visit(item, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      output[key] = SENSITIVE_FIELD.test(key)
        ? '[REDACTED]'
        : visit(child, depth + 1);
    }
    return output;
  };

  return visit(value, 0);
}
