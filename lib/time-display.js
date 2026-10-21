const formatters = new Map();
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const TIME_FIELDS = new Set([
  'recordedAt', 'occurredAt', 'createdAt', 'updatedAt', 'expiresAt',
  'startedAt', 'completedAt', 'selectedAt', 'decidedAt', 'retiredAt',
  'asOf', 'dueAt', 'reviewedAt', 'requestedAt', 'clearedAt',
  'accessedAt', 'deletedAt', 'purgedAt', 'capturedAt', 'lastRunAt', 'nextRunAt',
]);
const OPAQUE_FIELDS = new Set(['body', 'read', 'continueRead', 'lookup', 'arguments']);
const OPAQUE = Symbol('opaque');

function formatter(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) throw new TypeError('timeZone 必须是有效时区');
  let result = formatters.get(timeZone);
  if (!result) {
    try {
      result = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      });
    } catch { throw new TypeError('timeZone 必须是有效时区'); }
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
    formatters.set(timeZone, result);
  }
  return result;
}

function parsedInstant(value) {
  if (typeof value !== 'string') return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , , , offsetHour, offsetMinute] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +hour > 23 || +minute > 59 || +second > 59
    || (offsetHour !== undefined && (+offsetHour > 23 || +offsetMinute > 59))) return null;
  // Date.parse normalizes dates such as February 30; reject those explicitly.
  const calendar = new Date(0);
  calendar.setUTCFullYear(+year, +month - 1, +day);
  if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date : null;
}

/** Display a precise instant locally without changing the stored timestamp. */
export function formatMemoryTime(value, timeZone = 'Asia/Shanghai') {
  const display = formatter(timeZone);
  const date = parsedInstant(value);
  if (!date) return value;
  const parts = Object.fromEntries(display.formatToParts(date).map(part => [part.type, part.value]));
  if (parts.era !== 'AD' || +parts.year > 9999) return value;
  const millis = date.getUTCMilliseconds();
  const wall = new Date(0);
  wall.setUTCFullYear(+parts.year, +parts.month - 1, +parts.day);
  wall.setUTCHours(+parts.hour, +parts.minute, +parts.second, millis);
  const offsetMillis = wall.valueOf() - date.valueOf();
  // Historical second-level offsets cannot be represented losslessly as ±HH:mm.
  if (offsetMillis % 60000 !== 0 || Math.abs(offsetMillis) >= 24 * 3600000) return value;
  const minutes = Math.abs(offsetMillis / 60000);
  const offset = `${offsetMillis < 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const local = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(millis).padStart(3, '0')}${offset}`;
  return Date.parse(local) === date.valueOf() ? local : value;
}

/** Copy JSON-shaped output, localizing only known timestamp metadata fields. */
export function presentMemoryTimes(value, timeZone = 'Asia/Shanghai') {
  formatter(timeZone);
  const seen = new WeakMap();
  function copy(input, zone, opaque = false, queryRange = false) {
    if (input === null || typeof input !== 'object') return input;
    const context = opaque ? OPAQUE : `${zone}:${queryRange}`;
    let contexts = seen.get(input);
    if (contexts?.has(context)) return contexts.get(context);
    if (!contexts) { contexts = new Map(); seen.set(input, contexts); }
    if (input instanceof Date) {
      const cloned = new Date(input.valueOf());
      contexts.set(context, cloned);
      return cloned;
    }
    const output = Array.isArray(input) ? [] : {};
    contexts.set(context, output);
    for (const [key, item] of Object.entries(input)) {
      let next;
      if (opaque || OPAQUE_FIELDS.has(key)) next = copy(item, zone, true);
      else if (TIME_FIELDS.has(key) || (queryRange && ['start', 'endExclusive'].includes(key))) {
        next = item && typeof item === 'object' ? copy(item, zone, true) : formatMemoryTime(item, zone);
      }
      else if (key === 'mentionedTimes' && Array.isArray(item)) next = item.map(time => typeof time === 'string' ? formatMemoryTime(time, zone) : copy(time, zone));
      else if (key === 'resolvedTime' && item && typeof item === 'object' && !Array.isArray(item)) {
        const queryZone = typeof item.timeZone === 'string' && item.timeZone ? item.timeZone : zone;
        formatter(queryZone);
        next = copy(item, queryZone, false, true);
      } else next = copy(item, zone);
      Object.defineProperty(output, key, { value: next, enumerable: true, configurable: true, writable: true });
    }
    return output;
  }
  const output = copy(value, timeZone);
  if (output && typeof output === 'object' && !Array.isArray(output) && !(output instanceof Date)
    && (output.timeZone === undefined || output.timeZone === null || output.timeZone === '')) output.timeZone = timeZone;
  return output;
}
