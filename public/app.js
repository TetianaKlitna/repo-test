const $ = id => document.getElementById(id);
let filter = 'open', records = [], busy = false, recommendation = null;

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', ...options.headers } });
  let body;
  try { body = await response.json(); }
  catch { throw new Error(response.ok ? 'The inbox sent a response we could not read. Refresh to check its current state.' : 'The request could not be completed.'); }
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function render() {
  const inTab = {
    open: item => item.status === 'open' && !item.snoozed,
    snoozed: item => item.snoozed,
    resolved: item => item.status === 'resolved',
  };
  const shown = records.filter(inTab[filter]);
  $('requests').replaceChildren(...shown.map(item => {
    const card = document.createElement('article'); card.className = 'request';
    const body = document.createElement('div');
    body.append(text('h3', item.title), text('p', item.detail));
    const meta = text('p', '', 'meta');
    meta.append(text('span', `${item.guest} · Room ${item.room}`), text('span', item.urgency, `pill ${item.urgency}`));
    if (item.status === 'resolved') meta.append(text('span', 'Handled', 'pill resolved'));
    if (item.snoozed) meta.append(text('span', `Snoozed until ${new Date(item.snoozedUntil).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`, 'pill snoozed'));
    meta.append(text('time', new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'));
    body.append(meta);
    const button = text('button', item.status === 'open' ? 'Mark handled' : 'Reopen', 'handle');
    button.type = 'button'; button.disabled = busy; button.setAttribute('aria-label', `${button.textContent}: ${item.title}`);
    button.addEventListener('click', () => update(item));
    // Snoozed requests are parked until their time passes, so they get no action button.
    card.append(text('span', item.guest[0], 'guest-icon'), body, ...(item.snoozed ? [] : [button]));
    return card;
  }));
  const open = records.filter(inTab.open).length;
  $('open-count').textContent = `${open} open`; $('nav-count').textContent = open;
  $('snoozed-count').textContent = `(${records.filter(inTab.snoozed).length})`;
  $('empty').hidden = busy || !$('error').hidden || shown.length > 0;
  $('empty').textContent = { resolved: 'Handled requests will appear here.', snoozed: 'No snoozed requests right now.' }[filter] ?? 'All caught up. Your guests are in good hands.';
  $('refresh').disabled = busy;
  $('handle-next').disabled = busy;
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
}

function showError(error) {
  $('error').textContent = error.name === 'TimeoutError' ? 'The request took too long. Refresh the inbox to check its current state.' : error instanceof TypeError ? 'We could not reach the inbox. Check your connection, then refresh.' : error.message;
  $('error').hidden = false;
}

async function load() {
  if (busy) return;
  busy = true; $('status').textContent = 'Refreshing your inbox…'; $('error').hidden = true; render();
  try { records = (await api('/api/requests')).requests; await loadRecommendation(); }
  catch (error) { showError(error); }
  finally { busy = false; $('status').textContent = ''; render(); }
}

async function update(item) {
  if (busy) return;
  busy = true; $('error').hidden = true; $('status').textContent = ''; render();
  try {
    await api(`/api/requests/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ status: item.status === 'open' ? 'resolved' : 'open' }) });
    records = (await api('/api/requests')).requests;
    await loadRecommendation();
    $('status').textContent = item.status === 'open' ? 'Request marked handled.' : 'Request reopened.';
  } catch (error) { showError(error); }
  finally { busy = false; render(); }
}

for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
$('refresh').addEventListener('click', load);
void load();

async function loadRecommendation() {
  $('next-status').textContent = 'Finding the next request…';
  $('next-reason').textContent = '';
  $('next-error').hidden = true;
  $('handle-next').hidden = true;
  recommendation = null;
  try {
    const result = await api('/api/next-request');
    recommendation = result.request;
    $('next-status').textContent = recommendation ? recommendation.title : 'All caught up.';
    $('next-reason').textContent = result.reason;
    $('handle-next').hidden = !recommendation;
  } catch (error) {
    $('next-status').textContent = 'Recommendation unavailable.';
    $('next-error').textContent = error.message;
    $('next-error').hidden = false;
  }
}
$('handle-next').addEventListener('click', () => {
  if (recommendation && !busy) void update({ ...recommendation, status: 'open' });
});
