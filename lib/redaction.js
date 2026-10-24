// Scrub before hashing, persisting or clipping. Reports never contain matched text.
// Deliberately conservative patterns: this is credential hygiene, not a claim
// that arbitrary secrets or personal information can always be recognized.
const RULES = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/giu],
  ['api_key', /\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/gu],
  ['github_token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu],
  ['credential', /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|密码|密钥)["']?)\s*[:=：]\s*["']?)([^\s"'`,;，；}\]]{8,})/giu],
  ['url_credential', /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu],
];

export function redactText(value) {
  if (typeof value !== 'string') throw new TypeError('redactText requires text');
  let text = value;
  const redactions = [];
  for (const [type, pattern] of RULES) {
    let count = 0;
    text = text.replace(pattern, (...args) => {
      // Existing placeholders must remain stable across retries/imports.
      if ((type === 'credential' && args[2].startsWith('[REDACTED:')) || (type === 'url_credential' && args[0].includes('[REDACTED:'))) return args[0];
      count++;
      return type === 'credential' || type === 'url_credential'
        ? `${args[1]}[REDACTED:${type}]${type === 'url_credential' ? '@' : ''}`
        : `[REDACTED:${type}]`;
    });
    if (count) redactions.push({ type, count });
  }
  return { text, redactions, changed: text !== value };
}

export function sensitiveInventory(text) {
  const result = redactText(text);
  return { detected: result.changed, redactions: result.redactions };
}

/** A secondary write must not smuggle a recognizable credential around the
 * capture scrubber. Reject instead of rewriting IDs, quotes or audit payloads.
 * The model can read the sanitized A1 source and submit a corrected statement.
 */
export function assertSafeMemoryPayload(value) {
  function visit(item) {
    if (typeof item === 'string') {
      if (redactText(item).changed) {
        const error = new Error('Memory content contains a recognizable credential; replace it with a redaction placeholder and use the sanitized original for quotations.');
        error.code = 'MEMORY_SENSITIVE_CONTENT'; throw error;
      }
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) if (!/^(?:id|rawId|requestId|instanceId|sessionId|turnId|sourceRoot|hash|rawHash|contentHash|payloadHash|transactionId)$/u.test(key)) visit(child);
    }
  }
  visit(value);
}
