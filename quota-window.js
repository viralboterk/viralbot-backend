// YouTube Data API v3 quota resets at midnight Pacific Time. Pacific Time is
// UTC-7 (PDT) in summer and UTC-8 (PST) in winter — a fixed offset is wrong half
// the year. This computes the *actual* most recent and next reset instants using
// the IANA timezone database via Intl, so it stays correct across DST changes
// with no extra dependency.

function pacificOffsetHours(atUtcInstant) {
  // Read the GMT offset Los Angeles has at a given instant (e.g. "GMT-7" or "GMT-8").
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  }).formatToParts(atUtcInstant).find(p => p.type === 'timeZoneName').value;
  return parseInt(part.replace('GMT', ''), 10); // e.g. -7 or -8
}

// Returns the UTC instant (ms since epoch) of midnight Pacific Time for the
// Pacific calendar date that `refDate` currently falls on.
function pacificMidnightUTC(refDate) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(refDate); // "YYYY-MM-DD" in Pacific time

  // Use noon UTC on that date as a DST-unambiguous reference point to read the
  // offset, then apply it to the UTC-midnight guess for that same calendar date.
  const noonGuessUTC = new Date(ymd + 'T12:00:00Z');
  const offsetHours = pacificOffsetHours(noonGuessUTC); // -7 or -8

  const utcMidnightGuess = new Date(ymd + 'T00:00:00Z').getTime();
  return utcMidnightGuess - offsetHours * 3600000;
}

// Most recent quota reset at or before `refDate`.
function lastQuotaReset(refDate = new Date()) {
  const todayReset = pacificMidnightUTC(refDate);
  if (todayReset <= refDate.getTime()) return new Date(todayReset);
  // refDate is before today's Pacific-calendar midnight in UTC terms — use yesterday.
  const yesterday = new Date(refDate.getTime() - 24 * 3600000);
  return new Date(pacificMidnightUTC(yesterday));
}

// Next quota reset strictly after `refDate`.
function nextQuotaReset(refDate = new Date()) {
  const last = lastQuotaReset(refDate);
  const guessNext = new Date(last.getTime() + 24 * 3600000);
  // Re-derive precisely (handles the rare case where a DST transition happens
  // inside this 24h span and shifts the next reset by an hour).
  return new Date(pacificMidnightUTC(new Date(guessNext.getTime() + 3600000)));
}

// True if `scanDate` happened within the same quota window as `refDate` (default: now).
function isWithinCurrentQuotaWindow(scanDate, refDate = new Date()) {
  if (!scanDate) return false;
  const windowStart = lastQuotaReset(refDate).getTime();
  return new Date(scanDate).getTime() >= windowStart;
}

module.exports = { lastQuotaReset, nextQuotaReset, isWithinCurrentQuotaWindow };
