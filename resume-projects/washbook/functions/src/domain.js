export class BookingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function requireUser(actor) {
  if (!actor?.uid) throw new BookingError('unauthenticated', 'Sign in to continue.');
}

export function requireAdmin(actor) {
  requireUser(actor);
  if (!actor.isAdmin) throw new BookingError('permission-denied', 'Administrator access is required.');
}

export function docId(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new BookingError('invalid-argument', `${label} is invalid.`);
  }
  return value;
}

export function expectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new BookingError('invalid-argument', 'A valid version is required.');
  return value;
}

export function checkVersion(actual, expected) {
  expectedVersion(expected);
  if (actual !== expected) throw new BookingError('aborted', 'This changed while you were viewing it. Refresh and try again.');
}

export function duration(value) {
  if (![30, 45, 60].includes(value)) throw new BookingError('invalid-argument', 'Choose 30, 45, or 60 minutes.');
  return value;
}

export function reason(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 500) {
    throw new BookingError('invalid-argument', 'Please provide a reason between 3 and 500 characters.');
  }
  return value.trim();
}
