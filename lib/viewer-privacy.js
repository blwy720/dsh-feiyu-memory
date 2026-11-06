/** Export-boundary credential redaction. Analyze source JSON before sanitizing.
 * Returned data is detached. Deep/circular values fail closed; reports contain
 * only fixed reason names and counts, never source values or paths.
 */
const MAX_DEPTH = 64;
const PLACEHOLDER = /^\[REDACTED:[^\]\r\n]+\]$/u;
const PLACEHOLDER_PREFIX = /^\[REDACTED:[^\]\r\n]+\]/u;
const SECRET_KEYS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken',
  'sessiontoken', 'apikey', 'xapikey', 'secret', 'clientsecret', 'apisecret',
  'password', 'passwd', 'pwd', 'authorization', 'proxyauthorization',
  'cookie', 'setcookie', 'credentials', 'privatekey', 'signingkey',
]);
const KEY_PATTERN = '(?:proxy[-_ ]?authorization|authorization|set[-_ ]?cookie|cookie|'
  + 'access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|auth[-_ ]?token|'
  + 'bearer[-_ ]?token|session[-_ ]?token|token|x[-_ ]?api[-_ ]?key|api[-_ ]?key|'
  + 'client[-_ ]?secret|api[-_ ]?secret|secret|password|passwd|pwd|credentials|'
  + 'private[-_ ]?key|signing[-_ ]?key)';
const normalizeKey = key => key.toLowerCase().replace(/[-_\s]/gu, '');
const placeholderRanges = text => [...text.matchAll(/\[REDACTED:[^\]\r\n]+\]/gu)]
  .map(match => [match.index, match.index + match[0].length]);
const inPlaceholder = (ranges, offset) => ranges.some(([start, end]) => offset >= start && offset < end);

function createContext() {
  return { report: { counts: { redactions: 0 }, reasons: {} }, ancestors: new WeakSet() };
}

function mark(ctx, reason) {
  ctx.report.counts.redactions++;
  ctx.report.reasons[reason] = (ctx.report.reasons[reason] ?? 0) + 1;
  return `[REDACTED:${reason}]`;
}

function hasSecretValue(value, key) {
  if (value == null || value === '' || (typeof value === 'string' && PLACEHOLDER.test(value))) return false;
  // Numeric token fields represent usage counts; numeric strings remain secrets.
  if (key === 'token' && typeof value === 'number' && Number.isFinite(value)) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (value && typeof value === 'object' && Object.keys(value).length === 0) return false;
  return true;
}

/** Find balanced JSON containers without changing their contents. */
function containerEnd(text, start) {
  const stack = [];
  let quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function quotedEnd(text, start) {
  const quote = text[start];
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    if (escaped) escaped = false;
    else if (text[i] === '\\') escaped = true;
    else if (text[i] === quote) return i;
    else if (text[i] === '\n' || text[i] === '\r') return i;
  }
  return text.length;
}

function redactAssignments(text, ctx) {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_-])(?:(["'])(${KEY_PATTERN})\\2|(${KEY_PATTERN}))(\\s*[:=]\\s*)`, 'gimu');
  const protectedRanges = placeholderRanges(text);
  let result = '', cursor = 0, match;
  while ((match = re.exec(text))) {
    const start = re.lastIndex;
    if (start < cursor || inPlaceholder(protectedRanges, start - 1)) continue;
    const key = normalizeKey(match[3] ?? match[4]);
    const rest = text.slice(start);
    const placeholder = PLACEHOLDER_PREFIX.exec(rest);
    if (placeholder) { re.lastIndex = start + placeholder[0].length; continue; }
    if (!rest || /^[,;\r\n}\])]/u.test(rest)) continue;
    let end, valueStart = start, quoted = false;
    if (rest[0] === '"' || rest[0] === "'") {
      quoted = true;
      valueStart++;
      end = quotedEnd(text, start);
    } else if (rest[0] === '{' || rest[0] === '[') {
      end = containerEnd(text, start);
      if (end < 0) end = start + (rest.search(/[\r\n]/u) < 0 ? rest.length : rest.search(/[\r\n]/u));
    } else if ((key === 'cookie' || key === 'setcookie' || key.endsWith('authorization')) && match[5].includes(':')) {
      // HTTP header values may contain multiple space/semicolon/comma-separated secrets.
      const boundary = rest.search(/[\r\n"'<>]/u);
      end = start + (boundary < 0 ? rest.length : boundary);
    } else {
      const auth = key.endsWith('authorization') ? /^(?:Bearer|Basic|Token)\s+[^\s,;\]}\)"'&<>]+/iu.exec(rest) : null;
      const value = auth?.[0] ?? /^[^\s,;\]}\)"'&<>]+/u.exec(rest)?.[0] ?? '';
      end = start + value.length;
    }
    const value = text.slice(valueStart, end);
    if (!value || PLACEHOLDER.test(value) || (!quoted && key === 'token' && /^\d+(?:\.\d+)?$/u.test(value))) {
      re.lastIndex = Math.max(end, start);
      continue;
    }
    result += text.slice(cursor, valueStart) + mark(ctx, 'credential_assignment');
    cursor = end;
    re.lastIndex = end + (quoted && text[end] === text[start] ? 1 : 0);
  }
  return result + text.slice(cursor);
}

function sanitizeText(text, ctx, depth) {
  if (PLACEHOLDER.test(text)) return text;
  if (depth > MAX_DEPTH) return mark(ctx, 'depth_limit');
  const trimmed = text.trim();
  // Complete argumentsRaw/results/JSON strings are parsed before replacements.
  if (trimmed && ['{', '[', '"'].includes(trimmed[0])) {
    try {
      const parsed = JSON.parse(trimmed);
      const before = ctx.report.counts.redactions;
      const cleaned = visit(parsed, ctx, depth + 1);
      if (ctx.report.counts.redactions !== before) return JSON.stringify(cleaned);
      return text;
    } catch { /* Inspect embedded containers and assignments below. */ }
  }
  let assembled = '', cursor = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[' && text[i] !== '"') continue;
    const placeholder = PLACEHOLDER_PREFIX.exec(text.slice(i));
    if (placeholder) { i += placeholder[0].length - 1; continue; }
    const quoteEnd = text[i] === '"' ? quotedEnd(text, i) : -1;
    const end = text[i] === '"'
      ? (text[quoteEnd] === '"' ? quoteEnd + 1 : -1)
      : containerEnd(text, i);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end));
      const before = ctx.report.counts.redactions;
      const cleaned = visit(parsed, ctx, depth + 1);
      assembled += text.slice(cursor, i);
      assembled += ctx.report.counts.redactions === before ? text.slice(i, end) : JSON.stringify(cleaned);
      cursor = end;
      i = end - 1;
    } catch { /* Malformed fragments also pass through the assignment scanner. */ }
  }
  assembled += text.slice(cursor);
  const assigned = redactAssignments(assembled, ctx);
  const protectedRanges = placeholderRanges(assigned);
  return assigned.replace(/\bsk-[A-Za-z0-9._-]{11,}[A-Za-z0-9_-]/gu,
    (match, offset) => inPlaceholder(protectedRanges, offset) ? match : mark(ctx, 'api_key_shape'));
}

function visit(value, ctx, depth) {
  if (typeof value === 'string' && PLACEHOLDER.test(value)) return value;
  if (depth > MAX_DEPTH) return mark(ctx, 'depth_limit');
  if (typeof value === 'string') return sanitizeText(value, ctx, depth);
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return mark(ctx, 'unsupported_value');
    return value;
  }
  if (ctx.ancestors.has(value)) return mark(ctx, 'circular_reference');
  ctx.ancestors.add(value);
  let output;
  if (Array.isArray(value)) output = value.map(item => visit(item, ctx, depth + 1));
  else {
    output = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeKey(key);
      const cleaned = SECRET_KEYS.has(normalized) && hasSecretValue(item, normalized)
        ? mark(ctx, 'credential_field') : visit(item, ctx, depth + 1);
      Object.defineProperty(output, key, { value: cleaned, enumerable: true, writable: true, configurable: true });
    }
  }
  ctx.ancestors.delete(value);
  return output;
}

/** Sanitize the complete export, including hidden parsed fields and raw text. */
export function sanitizeExport(value) {
  const ctx = createContext();
  return { data: visit(value, ctx, 0), report: ctx.report };
}

/** Convenience for excerpts; final exports must still use sanitizeExport. */
export function redactText(text) {
  return sanitizeText(String(text ?? ''), createContext(), 0);
}
