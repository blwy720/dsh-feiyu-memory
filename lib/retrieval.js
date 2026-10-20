const DAY = 24 * 60 * 60 * 1000;
const AXES = new Set(['either', 'recorded', 'occurred', 'mentioned']);
const formatters = new Map();

function formatter(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) throw new TypeError('timeZone 必须是 IANA 时区');
  let value = formatters.get(timeZone);
  if (!value) {
    try { value = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { throw new TypeError('timeZone 必须是有效 IANA 时区'); }
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
    formatters.set(timeZone, value);
  }
  return value;
}

export function validateDate(value, name = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(`${name}必须是 YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError(`${name}不是有效日期`);
  return value;
}

export function localDate(value, timeZone = 'Asia/Shanghai') {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return null;
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(parsed).map(part => [part.type, part.value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

// Find the actual beginning of this local calendar date, including midnight
// skipped by a timezone transition. Never assume that a local day is 24 hours.
export function localDayStart(date, timeZone) {
  validateDate(date);
  formatter(timeZone);
  const nominal = Date.parse(`${date}T00:00:00.000Z`);
  let low = nominal - 2 * DAY, high = nominal + 2 * DAY;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(middle, timeZone) < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function instant(value, name = 'time') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) throw new TypeError(`${name}必须是带时区的 ISO 时间`);
  validateDate(value.slice(0, 10), name);
  const [h, m, s] = value.slice(11, 19).split(':').map(Number);
  const result = Date.parse(value);
  if (h > 23 || m > 59 || s > 59 || !Number.isFinite(result)) throw new TypeError(`${name}不是有效时间`);
  return result;
}

function bound(value, name, timeZone, end = false) {
  if (value === undefined) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    validateDate(value, name);
    return { date: value, millis: localDayStart(end ? shiftDate(value, 1) : value, timeZone) };
  }
  return { millis: instant(value, name) + (end ? 1 : 0) };
}

/** Explicit resolution only. A missing date never becomes a guessed date.
 * Legacy date/from/to upper bounds stay inclusive; resolved ranges are half-open.
 * recent_7_days is a rolling 168 hours; last_week is the previous local Mon–Sun.
 */
export function resolveTimeQuery(input = {}, { timeZone = 'Asia/Shanghai', now = new Date() } = {}) {
  const axis = input.timeAxis ?? 'either';
  if (!AXES.has(axis)) throw new TypeError('timeAxis 必须是 either、recorded、occurred 或 mentioned');
  formatter(timeZone);
  let from = input.from, to = input.to;
  if (input.date !== undefined) {
    validateDate(input.date);
    if (from !== undefined || to !== undefined) throw new TypeError('date 不能与 from/to 同时使用');
    from = to = input.date;
  }
  let fromBound, toBound, resolved;
  if (input.timeWindow !== undefined) {
    const window = input.timeWindow;
    if (!window || typeof window !== 'object' || Array.isArray(window)) throw new TypeError('timeWindow 必须是对象');
    for (const key of Object.keys(window)) if (!['preset', 'asOf', 'timeZone'].includes(key)) throw new TypeError(`不支持 timeWindow.${key}`);
    if (from !== undefined || to !== undefined) throw new TypeError('timeWindow 不能与 date/from/to 同时使用');
    if (!['last_week', 'recent_7_days'].includes(window.preset)) throw new TypeError('timeWindow.preset 必须是 last_week 或 recent_7_days');
    timeZone = window.timeZone ?? timeZone;
    formatter(timeZone);
    const asOf = window.asOf === undefined ? new Date(now).valueOf() : instant(window.asOf, 'asOf');
    if (!Number.isFinite(asOf)) throw new TypeError('asOf 不是有效时间');
    let start, end, localStartDate, localEndDateExclusive;
    if (window.preset === 'last_week') {
      const day = localDate(asOf, timeZone);
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      localEndDateExclusive = shiftDate(day, -((weekday + 6) % 7));
      localStartDate = shiftDate(localEndDateExclusive, -7);
      start = localDayStart(localStartDate, timeZone);
      end = localDayStart(localEndDateExclusive, timeZone);
      fromBound = { date: localStartDate, millis: start };
      toBound = { date: shiftDate(localEndDateExclusive, -1), millis: end };
    } else {
      start = asOf - 7 * DAY; end = asOf;
      fromBound = { millis: start }; toBound = { millis: end };
    }
    resolved = { preset: window.preset, asOf: new Date(asOf).toISOString(),
      ...(localStartDate ? { localStartDate, localEndDateExclusive } : {}),
      start: new Date(start).toISOString(), endExclusive: new Date(end).toISOString() };
  } else {
    fromBound = bound(from, 'from', timeZone);
    toBound = bound(to, 'to', timeZone, true);
    if (fromBound && toBound && fromBound.millis >= toBound.millis) throw new TypeError('from 不能晚于 to');
    resolved = fromBound || toBound ? { preset: 'explicit',
      start: fromBound ? new Date(fromBound.millis).toISOString() : null,
      endExclusive: toBound ? new Date(toBound.millis).toISOString() : null,
      inputFrom: from ?? null, inputTo: to ?? null } : null;
  }
  return { axis, timeZone, fromBound, toBound, hasTimeFilter: Boolean(resolved),
    resolvedTime: resolved ? { ...resolved, timeZone, axis, interval: '[start,endExclusive)' } : null };
}

function validTimes(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))))];
}

export function mentionedTimes(record, { getRaw, getEntry } = {}) {
  if (record.kind === 'raw' || record.pool === 'a') return validTimes([record.recordedAt]);
  if (Array.isArray(record.mentionedTimes) || Array.isArray(record.sourceTimes)) return validTimes([
    ...(Array.isArray(record.mentionedTimes) ? record.mentionedTimes : []),
    ...(Array.isArray(record.sourceTimes) ? record.sourceTimes.map(source => source?.recordedAt) : []),
  ]);
  // Compatibility for old records: derive only from surviving exact sources,
  // never from the date the memory/archive itself was written.
  const times = [];
  if (getRaw) for (const source of record.sources ?? []) {
    const raw = getRaw(source.rawId);
    if (raw) times.push(raw.recordedAt);
  }
  if (getEntry && record.kind === 'a3') for (const reference of record.sourceEntries ?? []) {
    const parent = getEntry(reference.id, { version: reference.version });
    if (parent && parent.kind !== 'a3') times.push(...mentionedTimes(parent, { getRaw }));
  }
  return validTimes(times);
}

export function matchTime(record, query, mentions = []) {
  const inRange = value => {
    if (!value) return false;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && (!query.fromBound || milliseconds >= query.fromBound.millis) &&
      (!query.toBound || milliseconds < query.toBound.millis);
  };
  const matchedAxes = [];
  if (inRange(record.recordedAt)) matchedAxes.push('recorded');
  if (inRange(record.occurredAt)) matchedAxes.push('occurred');
  if (mentions.some(inRange)) matchedAxes.push('mentioned');
  const axes = query.axis === 'either' ? ['recorded', 'occurred'] : [query.axis];
  const axisKnown = axes.some(axis => axis === 'mentioned' ? mentions.length > 0 : Boolean(record[`${axis}At`]));
  return { matches: !query.hasTimeFilter || axes.some(axis => matchedAxes.includes(axis)),
    matchedAxes: query.hasTimeFilter ? matchedAxes.filter(axis => axes.includes(axis)) : [],
    unknownTime: query.hasTimeFilter && !axisKnown };
}
