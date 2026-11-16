# Guest desk handoff

## Decision
What did you keep or change? Include a focused diff or accessible code link.

**Diff:** `git diff 5a06195` (commit `5a06195` is the untouched starter from the zip). PR link: _to add_.

### Round 1: review of the Handle next draft

**Kept as is**
- The browser flow: Handle next shows the backend's choice, **Mark handled** goes through the existing `PATCH /api/requests/:id`, then the list and the next recommendation are reloaded (`public/app.js`).
- The `busy` guard against double clicks, the 8-second timeout, network error messages, server hardening (CSP, 4 KB body limit, ID pattern, fixed file list).

**Changed**
| Problem in the draft | Fix | File |
|---|---|---|
| Resolved requests were recommended (seed returned **GD-104**, which is resolved, even when every request was resolved) | Filter to `status === 'open'` before choosing | `server.js` `nextRequest()` |
| Exact-time ties sorted by **descending** ID (picked GD-105 over GD-103) | Ascending ID, compared numerically (`GD-99` before `GD-100`) | `server.js` `byPriority` |
| Reason was the same text every time | Reason explains the pick: urgency, waiting since, oldest of N, tie with which ID | `server.js` `nextRequest()` |
| A stale "Request marked handled." could stay next to a new error | Clear the status line when an update starts | `public/app.js` `update()` |
| A non-JSON reply showed a raw parse error | Plain message; checks the HTTP status first | `public/app.js` `api()` |

**Usability improvement:** the inbox list now uses the same order as the recommendation (open first, then urgency, oldest, ID), so the top open card is always the Handle next request. The subtitle "Oldest requests first" was updated to match.

### Round 2: new requirement, `snoozedUntil`
- An open request whose `snoozedUntil` is a **valid** timestamp **later than now** is left out of recommendations. Missing, invalid or expired values don't exclude it. Ordering and the resolved rule are unchanged.
- `/api/requests` adds a derived `snoozed: true/false` flag (never stored) using the same check, so the page and the recommendation always agree.
- Page: tabs are now **Open requests** (actionable only), **Snoozed (N)** and **Handled**. Snoozed cards show "Snoozed until … UTC" and have no action button.
- `requests.json` has two examples: GD-102 (expired, so still recommended) and GD-106 (future, so snoozed).

## Why
Which user requirement and evidence support the decision? Note important assumptions.

| README requirement | Evidence |
|---|---|
| Return an existing open request and a useful reason, or `request: null` with a reason | Tests: seed returns GD-103 with a reason naming the tie; empty and all-resolved inboxes return `null` plus a reason |
| Urgent, normal, low; then oldest `createdAt`; then ascending ID | Test that resolves 6 requests one by one and checks the full order |
| Never recommend a resolved request | Test where the resolved request ranks highest |
| Browser uses the backend decision and marks handled through the existing API | Kept the draft's flow; the server side of the sequence is tested (GD-103, then GD-105, then GD-102) |
| A failed update must not look successful | `app.js` fixes above |
| New: skip a valid future snooze; missing, invalid or expired doesn't exclude | 14 snooze tests (see below) |

**Assumptions**
- **"Valid timestamp" means a full ISO date-time with `Z` or an offset** (for example `2026-11-16T15:30:00Z` or `…+02:00`) on a real calendar date. Plain `Date.parse` is too lenient: it turns `2026-02-30` into March 2, accepts `"Nov 16 2026"`, and reads values without a timezone in the server's local time. Those values are treated as invalid, so the request stays visible, which is the safe direction.
- **A snooze ending exactly now counts as expired**, because the requirement says "later than the current time".
- **Request IDs are compared numerically.**
- **An unknown urgency value is not handled.** The seed has none and the API can't set one.

**Decisions beyond the stated requirements** (made at my request; a reviewer may question them)
- **The Open requests tab excludes snoozed items**, so it lists only actionable work and matches Handle next.
- **The All requests tab was removed.** The README says to keep existing filters; I chose three tabs that cover every request with no overlap. Easy to restore.
- **Snoozed cards have no Mark handled button.** This is UI only: the server still accepts the update.

## How I checked
List actual commands and browser actions, results and anything not verified. Distinguish observed results from a proposed test plan.

### Observed (commands actually run)
| Step | Command | Result |
|---|---|---|
| Baseline | `node --version`; `npm test` | v24.18.0; 4 of 4 pass |
| Draft behavior | A small script calling `/api/next-request` | Seed returned **GD-104 (resolved)**; with all requests resolved it still returned GD-104 |
| Draft against new tests | `node --test test/next-request.test.js` | **5 of 7 failed**; the 2 passing were the empty-inbox and no-mutation tests |
| After round 1 | `npm test` | 12 of 12 pass |
| Snooze tests before implementing | `npm test` | **4 of 19 failed**; the 3 "must not exclude" tests passed, which guards against over-excluding |
| Final | `npm test`; `node --check public/app.js` | **26 of 26 pass**; syntax OK |
| Snooze scenarios | `nextRequest()` with a fixed clock | GD-103 snoozed gives GD-105; both urgent snoozed gives GD-102 ("No urgent requests are available"); invalid or expired gives GD-103; all snoozed gives `null`, "…first returns at 2026-11-16 13:15 UTC" (input `+01:00`, converted correctly) |
| Live server | `curl /api/requests`, `/api/next-request` after restart | Open first, then urgency and date; list top equals Handle next |

**Test coverage** (`test/next-request.test.js`, 22 tests): ordering, resolved exclusion, empty and all-resolved, queue progression, list order, no mutation; snooze: future excluded, 12 invalid, expired or missing values not excluded, offset and fractional-second formats, expiry over time, resolved plus snooze, all snoozed, list unaffected, seed data before, at and after the boundary, reopen, `snoozed` flag, flag not stored.

### Browser: _to fill in with what I actually saw_
- [ ] Handle next shows GD-103 with its reason → _result_
- [ ] Mark handled through the queue until "All caught up." → _result_
- [ ] Open requests / Snoozed / Handled tabs and counts → _result_
- [ ] GD-106 under Snoozed with a label and no button; after its time passes, Refresh moves it to Open → _result_
- [ ] Reopen on a handled request → _result_
- [ ] Stop the server, click Mark handled: an error, with no success message → _result_

### Not verified
- No automated browser tests; everything on the page above depends on the manual check.
- Mobile layout with the extra tab.

## Working with AI
Include the important prompt or suggestion and how you evaluated it. A short account is enough; no need for a complete chat export.

I used Claude Code.
- **Safety first:** asked it to review the project, scripts, network calls and dependencies before running anything. It read every file first; nothing suspicious was found.
- **Trust but verify:** asked it to identify the draft's bugs. I didn't accept the claims from reading alone: it reproduced them with a script (GD-104 recommended) and wrote tests that **failed on the draft** before any fix.
- **Rejected or redirected:** I reverted the first fix to review it, then had it reapplied. I asked for list sorting, a Snoozed tab, no button on snoozed cards, and removal of All requests; each was a deliberate decision recorded above.
- **Caught during review:**
  - The AI's first version of a test expected the wrong order for two resolved requests; the code was right, so the test was corrected.
  - A reason that said "No urgent requests are open" while an urgent request was snoozed was reworded to "available".
  - The page didn't change because the running server needed a restart.
- **Strict timestamp check:** it tested `Date.parse` on edge cases before deciding what "valid" means, rather than assuming.

## Remaining work
What should the next engineer know?
- **Restart after server changes.** Data and `server.js` load at startup; `npm start` again after changing either.
- **GD-106's sample snooze time** must be in the future for the Snoozed tab to show anything. Generate one with `node -e "console.log(new Date(Date.now()+60*60*1000).toISOString())"`.
- **The page doesn't refresh by itself** when a snooze expires; the operator must click Refresh inbox.
- **There's no way to set a snooze from the page or API**; only by editing `requests.json`.
- **The server still accepts marking a snoozed request handled**; only the button is hidden.
- **An error from Handle next's Mark handled** appears in the inbox's error area, not next to the button.
- **If the update succeeds but the reload after it fails,** the page shows an error although the change was saved; Refresh shows the true state.
- **Unknown urgency values break the sort.**
- **Removing All requests goes against "keep existing filters"**; restore it if the reviewer disagrees.
