import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const seed = JSON.parse(readFileSync(new URL('./requests.json', import.meta.url), 'utf8'));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  }
  if (size > 4096) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Send a JSON object.'), { status: 400 }); }
}

const urgencyRank = { urgent: 0, normal: 1, low: 2 };
const byPriority = (a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency]
  || a.createdAt.localeCompare(b.createdAt)
  || a.id.localeCompare(b.id, 'en', { numeric: true });
// Inbox order: open before resolved, then the same priority used for the recommendation,
// so the first open, non-snoozed card in the list is the recommended request.
const byStatusThenPriority = (a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || byPriority(a, b);

// A snooze counts only if snoozedUntil is a full ISO date-time with Z or an offset, names a
// real calendar date, and is later than now. Anything else (missing, malformed, date-only,
// no timezone, rolled-over dates like Feb 30, expired) leaves the request recommendable.
const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function snoozeEnd(item) {
  const parts = typeof item.snoozedUntil === 'string' && item.snoozedUntil.match(isoTimestamp);
  if (!parts) return null;
  const [year, month, day, hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = parts.slice(1);
  const calendar = new Date(Date.UTC(+year, +month - 1, +day));
  if (calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day) return null;
  if (+hour > 23 || +minute > 59 || +second > 59 || +offsetHour > 23 || +offsetMinute > 59) return null;
  const time = Date.parse(item.snoozedUntil);
  return Number.isNaN(time) ? null : time;
}
const isSnoozed = (item, now) => (snoozeEnd(item) ?? -Infinity) > now;
const utcLabel = time => new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// Picks the open request to handle next and explains why, in the operator's terms.
export function nextRequest(records, now = Date.now()) {
  const open = records.filter(item => item.status === 'open');
  const snoozed = open.filter(item => isSnoozed(item, now));
  const available = open.filter(item => !isSnoozed(item, now)).toSorted(byPriority);
  const request = available[0];
  const snoozedNote = snoozed.length ? `${snoozed.length} snoozed request${snoozed.length === 1 ? '' : 's'} skipped.` : '';
  if (!request) {
    if (snoozed.length) {
      const nextReturn = Math.min(...snoozed.map(snoozeEnd));
      return { request: null, reason: `Nothing to handle right now: ${snoozed.length} snoozed request${snoozed.length === 1 ? '' : 's'}, the first returns at ${utcLabel(nextReturn)}.` };
    }
    return { request: null, reason: records.length ? 'All requests are handled. No open requests remain.' : 'The inbox is empty. No open requests remain.' };
  }
  const sameUrgency = available.filter(item => item.urgency === request.urgency);
  const tiedWith = sameUrgency.filter(item => item !== request && item.createdAt === request.createdAt).map(item => item.id);
  const since = new Date(request.createdAt).toISOString().slice(11, 16);
  const parts = [`${request.urgency[0].toUpperCase()}${request.urgency.slice(1)}, waiting since ${since} UTC.`];
  if (request.urgency !== 'urgent') parts.push(`No ${request.urgency === 'low' ? 'urgent or normal' : 'urgent'} requests are ${snoozed.length ? 'available' : 'open'}.`);
  if (sameUrgency.length > 1) parts.push(`Oldest of ${sameUrgency.length} open ${request.urgency} requests.`);
  if (tiedWith.length) parts.push(`Created at the same time as ${tiedWith.join(', ')}; lower ID goes first.`);
  if (snoozedNote) parts.push(snoozedNote);
  return { request, reason: parts.join(' ') };
}

// A new server starts with independent fictional records. A browser reload keeps changes;
// restarting the process resets them. The exercise does not need a database or credentials.
export function createStarterServer({ requests = seed, now = () => Date.now() } = {}) {
  const records = structuredClone(requests);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && files.has(pathname)) {
        const [file, type] = files.get(pathname);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(readFileSync(new URL(`./public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && pathname === '/api/next-request') {
        return json(res, 200, nextRequest(records, now()));
      }
      if (req.method === 'GET' && pathname === '/api/requests') {
        const at = now();
        // `snoozed` is derived, never stored: true only for an open request whose snooze is valid and still in the future.
        const requests = records.toSorted(byStatusThenPriority).map(item => ({ ...item, snoozed: item.status === 'open' && isSnoozed(item, at) }));
        return json(res, 200, { requests });
      }
      const match = pathname.match(/^\/api\/requests\/([A-Z0-9-]+)$/);
      if (req.method === 'PATCH' && match) {
        const record = records.find(item => item.id === match[1]);
        if (!record) return json(res, 404, { error: 'Request not found.' });
        const body = await readBody(req);
        if (!body || Array.isArray(body) || !['open', 'resolved'].includes(body.status)) return json(res, 400, { error: 'Status must be open or resolved.' });
        record.status = body.status;
        return json(res, 200, { request: record });
      }
      return json(res, 404, { error: 'This route is not available.' });
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 43211);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  createStarterServer().listen(port, '127.0.0.1', () => console.log(`Guest desk: http://127.0.0.1:${port}`));
}
