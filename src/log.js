// Logging, with one hard rule: a device token never reaches a log.
//
// This is not tidiness. A token IS the credential for a channel that carries
// every page the user reads and every password they type, so a token in a log
// file is a token in every backup, every log shipper and every support bundle.
// Every secret the process knows is registered here at startup, and every line
// is scrubbed on the way out rather than at each call site -- a rule applied
// per call site is a rule that one call site gets wrong.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join('[redacted]');
  }
  // A base64url device token has no spaces and is at least 43 characters, so a
  // token that reached a log by a path this module did not anticipate -- a
  // stack trace, an unhandled rejection -- is still caught.
  return out.replace(/\b[A-Za-z0-9_-]{43,}\b/g, '[redacted]');
}

export function createLog({ level = 'info', sink = console, secrets = [] } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const registered = new Set(secrets);
  const emit = (name, stream, args) => {
    if (LEVELS[name] < threshold) return;
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
      .join(' ');
    stream.write(`${new Date().toISOString()} ${name.toUpperCase()} ${redact(line, registered)}\n`);
  };

  return {
    /** Register a value that must never appear in a line, at any level. */
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 8) registered.add(secret);
      return this;
    },
    debug: (...args) => emit('debug', sink.out ?? process.stdout, args),
    info: (...args) => emit('info', sink.out ?? process.stdout, args),
    warn: (...args) => emit('warn', sink.err ?? process.stderr, args),
    error: (...args) => emit('error', sink.err ?? process.stderr, args),
    child(prefix) {
      const parent = this;
      const forward = (name) => (...args) => parent[name](prefix, ...args);
      return {
        addSecret: parent.addSecret.bind(parent),
        debug: forward('debug'),
        info: forward('info'),
        warn: forward('warn'),
        error: forward('error'),
        child: (nested) => parent.child(`${prefix} ${nested}`),
      };
    },
  };
}

function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
