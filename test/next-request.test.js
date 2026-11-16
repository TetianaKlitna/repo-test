import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarterServer } from '../server.js';

async function fixture(t, options) {
  const server = createStarterServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

const next = async call => {
  const response = await call('/api/next-request');
  assert.equal(response.status, 200);
  return response.json();
};
const resolve = (call, id) => call(`/api/requests/${id}`, { method: 'PATCH', body: '{"status":"resolved"}' });
const item = (id, urgency, createdAt, status = 'open') =>
  ({ id, guest: 'Test', room: '1', title: `Title ${id}`, detail: '', urgency, status, createdAt });

test('the seed inbox recommends GD-103: urgent, oldest open, lower ID wins the 08:30 tie', async t => {
  const { request, reason } = await next(await fixture(t));
  assert.equal(request.id, 'GD-103');
  assert.equal(request.status, 'open');
  assert.match(reason, /urgent/i);
  assert.match(reason, /GD-105/, 'reason should explain the exact-time tie');
});

test('a resolved request is never recommended, even when it ranks highest', async t => {
  const call = await fixture(t, { requests: [
    item('R-1', 'urgent', '2026-11-03T07:00:00Z', 'resolved'),
    item('R-2', 'low', '2026-11-03T09:00:00Z'),
  ] });
  assert.equal((await next(call)).request.id, 'R-2');
});

test('order is urgency, then oldest createdAt, then ascending ID', async t => {
  const call = await fixture(t, { requests: [
    item('R-6', 'low', '2026-11-03T06:00:00Z'),
    item('R-5', 'normal', '2026-11-03T08:00:00Z'),
    item('R-4', 'normal', '2026-11-03T07:00:00Z'),
    item('R-3', 'urgent', '2026-11-03T09:00:00Z'),
    item('R-2', 'urgent', '2026-11-03T08:00:00Z'),
    item('R-1', 'urgent', '2026-11-03T09:00:00Z'),
  ] });
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const { request } = await next(call);
    seen.push(request.id);
    assert.equal((await resolve(call, request.id)).status, 200);
  }
  assert.deepEqual(seen, ['R-2', 'R-1', 'R-3', 'R-4', 'R-5', 'R-6']);
});

test('handling the recommendation moves the queue on to the next open request', async t => {
  const call = await fixture(t);
  await resolve(call, 'GD-103');
  assert.equal((await next(call)).request.id, 'GD-105');
  await resolve(call, 'GD-105');
  assert.equal((await next(call)).request.id, 'GD-102');
});

test('an inbox with only resolved requests returns request:null and a reason', async t => {
  const call = await fixture(t, { requests: [item('R-1', 'urgent', '2026-11-03T07:00:00Z', 'resolved')] });
  const body = await next(call);
  assert.equal(body.request, null);
  assert.ok(body.reason.length > 0);
});

test('an empty inbox returns request:null and a reason', async t => {
  const body = await next(await fixture(t, { requests: [] }));
  assert.equal(body.request, null);
  assert.ok(body.reason.length > 0);
});

test('the inbox list is sorted open first, then urgency, oldest, ID, and starts with the recommendation', async t => {
  const call = await fixture(t);
  const ids = async () => (await (await call('/api/requests')).json()).requests.map(item => item.id);
  assert.deepEqual(await ids(), ['GD-103', 'GD-105', 'GD-102', 'GD-106', 'GD-101', 'GD-104']);
  assert.equal((await ids())[0], (await next(call)).request.id);
  await resolve(call, 'GD-103');
  assert.deepEqual(await ids(), ['GD-105', 'GD-102', 'GD-106', 'GD-101', 'GD-104', 'GD-103']);
});

// --- snoozedUntil -----------------------------------------------------------------
const NOW = Date.parse('2026-11-16T12:00:00Z');
const snoozed = (base, snoozedUntil) => ({ ...base, snoozedUntil });

test('a request snoozed until a later time is skipped; the next one by the usual order is recommended', async t => {
  const requests = (await import('../requests.json', { with: { type: 'json' } })).default
    .map(entry => snoozed(entry, entry.id === 'GD-103' ? '2026-11-16T13:00:00Z' : undefined));
  const { request, reason } = await next(await fixture(t, { requests, now: () => NOW }));
  assert.equal(request.id, 'GD-105');
  assert.match(reason, /1 snoozed/);
});

test('a missing, invalid or expired snoozedUntil does not exclude the request', async t => {
  const values = [undefined, null, '', 'not a date', 'Nov 16 2026 13:00', '2026-11-16', '2026-11-16T13:00:00',
    '2026-02-30T13:00:00Z', '2026-11-16T25:00:00Z', 1794834000000, '2026-11-16T11:59:59Z', '2026-11-16T12:00:00Z'];
  for (const value of values) {
    const call = await fixture(t, { now: () => NOW, requests: [
      snoozed(item('R-1', 'urgent', '2026-11-03T07:00:00Z'), value),
      item('R-2', 'low', '2026-11-03T06:00:00Z'),
    ] });
    assert.equal((await next(call)).request.id, 'R-1', `snoozedUntil ${JSON.stringify(value)} should not exclude`);
  }
});

test('valid future timestamps with an offset or fractional seconds exclude the request', async t => {
  for (const value of ['2026-11-16T12:00:01Z', '2026-11-16T13:00+00:00', '2026-11-16T14:30:00.250+02:00']) {
    const call = await fixture(t, { now: () => NOW, requests: [
      snoozed(item('R-1', 'urgent', '2026-11-03T07:00:00Z'), value),
      item('R-2', 'low', '2026-11-03T06:00:00Z'),
    ] });
    assert.equal((await next(call)).request.id, 'R-2', `snoozedUntil ${value} should exclude`);
  }
});

test('a snooze ends on its own once the time passes', async t => {
  let clock = NOW;
  const call = await fixture(t, { now: () => clock, requests: [
    snoozed(item('R-1', 'urgent', '2026-11-03T07:00:00Z'), '2026-11-16T12:30:00Z'),
    item('R-2', 'low', '2026-11-03T06:00:00Z'),
  ] });
  assert.equal((await next(call)).request.id, 'R-2');
  clock = Date.parse('2026-11-16T12:30:01Z');
  assert.equal((await next(call)).request.id, 'R-1');
});

test('a resolved request stays excluded whatever its snooze says', async t => {
  const call = await fixture(t, { now: () => NOW, requests: [
    snoozed(item('R-1', 'urgent', '2026-11-03T07:00:00Z', 'resolved'), '2026-11-01T00:00:00Z'),
    snoozed(item('R-2', 'urgent', '2026-11-03T08:00:00Z', 'resolved'), 'not a date'),
    item('R-3', 'low', '2026-11-03T06:00:00Z'),
  ] });
  assert.equal((await next(call)).request.id, 'R-3');
});

test('when every open request is snoozed, request is null and the reason says when one returns', async t => {
  const call = await fixture(t, { now: () => NOW, requests: [
    snoozed(item('R-1', 'urgent', '2026-11-03T07:00:00Z'), '2026-11-16T15:00:00Z'),
    snoozed(item('R-2', 'low', '2026-11-03T06:00:00Z'), '2026-11-16T13:45:00Z'),
    item('R-3', 'normal', '2026-11-03T05:00:00Z', 'resolved'),
  ] });
  const { request, reason } = await next(call);
  assert.equal(request, null);
  assert.match(reason, /2 snoozed/);
  assert.match(reason, /2026-11-16 13:45 UTC/);
});

test('snoozing affects only the recommendation: the inbox list and its order are unchanged', async t => {
  const call = await fixture(t, { now: () => NOW, requests: [
    snoozed(item('R-1', 'urgent', '2026-11-03T07:00:00Z'), '2026-11-16T13:00:00Z'),
    item('R-2', 'low', '2026-11-03T06:00:00Z'),
  ] });
  const { requests } = await (await call('/api/requests')).json();
  assert.deepEqual(requests.map(entry => entry.id), ['R-1', 'R-2']);
  assert.equal(requests[0].snoozedUntil, '2026-11-16T13:00:00Z');
});

// --- snoozedUntil in the seed data (requests.json) ------------------------------------
// GD-102 has an expired snooze (2026-11-03 09:00Z); GD-106 has a snooze you can edit freely.
// The clock is set relative to GD-106's value, so these tests pass whatever time is in the file.
const seedData = (await import('../requests.json', { with: { type: 'json' } })).default;
const GD106_UNTIL = seedData.find(entry => entry.id === 'GD-106').snoozedUntil;
const GD106_END = Date.parse(GD106_UNTIL);
const SEED_NOW = GD106_END - 60 * 60 * 1000; // one hour before GD-106 returns
const utc = time => new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const drain = async call => {
  const steps = [];
  for (let i = 0; i < 10; i++) {
    const { request, reason } = await next(call);
    steps.push({ id: request?.id ?? null, reason });
    if (!request) break;
    assert.equal((await resolve(call, request.id)).status, 200);
  }
  return steps;
};

test('seed: before the snooze ends, GD-106 is skipped and GD-102 (expired snooze) is still recommended', async t => {
  const steps = await drain(await fixture(t, { now: () => SEED_NOW }));
  assert.deepEqual(steps.map(step => step.id), ['GD-103', 'GD-105', 'GD-102', 'GD-101', null]);
  for (const step of steps.slice(0, -1)) assert.match(step.reason, /1 snoozed request skipped/);
  assert.equal(steps.at(-1).reason, `Nothing to handle right now: 1 snoozed request, the first returns at ${utc(GD106_END)}.`);
});

test('seed: one second before the snooze ends GD-106 is still skipped; one second after, it is back in order', async t => {
  const before = await fixture(t, { now: () => GD106_END - 1000 });
  assert.deepEqual((await drain(before)).map(step => step.id), ['GD-103', 'GD-105', 'GD-102', 'GD-101', null]);
  const after = await fixture(t, { now: () => GD106_END + 1000 });
  const steps = await drain(after);
  assert.deepEqual(steps.map(step => step.id), ['GD-103', 'GD-105', 'GD-102', 'GD-106', 'GD-101', null]);
  assert.doesNotMatch(steps[0].reason, /snoozed/);
  assert.equal(steps.at(-1).reason, 'All requests are handled. No open requests remain.');
});

test('seed: snoozes do not hide anything from the inbox list', async t => {
  const call = await fixture(t, { now: () => SEED_NOW });
  const { requests } = await (await call('/api/requests')).json();
  assert.equal(requests.length, 6);
  assert.equal(requests.find(entry => entry.id === 'GD-106').snoozedUntil, GD106_UNTIL);
  assert.equal(requests.find(entry => entry.id === 'GD-102').snoozedUntil, '2026-11-03T09:00:00Z');
});

test('seed: reopening a handled request does not clear or bypass a snooze', async t => {
  const call = await fixture(t, { now: () => SEED_NOW });
  await drain(call);
  assert.equal((await call('/api/requests/GD-106', { method: 'PATCH', body: '{"status":"open"}' })).status, 200);
  assert.equal((await next(call)).request, null, 'GD-106 is open but still snoozed');
  assert.equal((await call('/api/requests/GD-102', { method: 'PATCH', body: '{"status":"open"}' })).status, 200);
  assert.equal((await next(call)).request.id, 'GD-102');
});

test('the list marks snoozed: true only for open requests with a valid future snooze (drives the Snoozed tab)', async t => {
  let clock = NOW;
  const call = await fixture(t, { now: () => clock, requests: [
    snoozed(item('R-1', 'urgent', '2026-11-03T07:00:00Z'), '2026-11-16T13:00:00Z'),
    snoozed(item('R-2', 'urgent', '2026-11-03T08:00:00Z'), 'not a date'),
    snoozed(item('R-3', 'normal', '2026-11-03T07:00:00Z'), '2026-11-16T11:00:00Z'),
    snoozed(item('R-4', 'normal', '2026-11-03T07:00:00Z', 'resolved'), '2026-11-16T13:00:00Z'),
    item('R-5', 'low', '2026-11-03T07:00:00Z'),
  ] });
  const flags = async () => Object.fromEntries((await (await call('/api/requests')).json()).requests.map(entry => [entry.id, entry.snoozed]));
  assert.deepEqual(await flags(), { 'R-1': true, 'R-2': false, 'R-3': false, 'R-4': false, 'R-5': false });
  clock = Date.parse('2026-11-16T13:00:01Z');
  assert.deepEqual(await flags(), { 'R-1': false, 'R-2': false, 'R-3': false, 'R-4': false, 'R-5': false });
});

test('seed: the Snoozed tab would show only GD-106, and the Open tab starts with the recommendation', async t => {
  const call = await fixture(t, { now: () => SEED_NOW });
  const { requests } = await (await call('/api/requests')).json();
  assert.deepEqual(requests.filter(entry => entry.snoozed).map(entry => entry.id), ['GD-106']);
  const openTab = requests.filter(entry => entry.status === 'open' && !entry.snoozed).map(entry => entry.id);
  assert.deepEqual(openTab, ['GD-103', 'GD-105', 'GD-102', 'GD-101']);
  assert.equal(openTab[0], (await next(call)).request.id);
});

test('the snoozed flag is computed for the response only and never saved into the record', async t => {
  const call = await fixture(t, { now: () => NOW });
  await call('/api/requests');
  const response = await call('/api/requests/GD-106', { method: 'PATCH', body: '{"status":"open"}' });
  assert.equal((await response.json()).request.snoozed, undefined);
});

test('recommending does not change any record', async t => {
  const call = await fixture(t);
  const before = await (await call('/api/requests')).json();
  await next(call);
  assert.deepEqual(await (await call('/api/requests')).json(), before);
});
