import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { BookingError, requireUser, requireAdmin, docId, checkVersion, duration, reason } from './domain.js';

const MINUTE = 60000;

export function createService(db, clock = () => Date.now()) {
  const ref = (collection, id) => db.collection(collection).doc(id);
  const audit = (tx, actor, action, machineId, sessionId, detail, now) => tx.create(ref('audit', randomUUID()),
    {actorUid: actor.uid, action, machineId, sessionId: sessionId || null, detail, createdAt: now});

  function requestRef(actor, input) {
    requireUser(actor);
    docId(actor.uid, 'User ID');
    return ref('requests', `${actor.uid}_${docId(input.requestId, 'Request ID')}`);
  }

  async function cached(tx, request, action, input) {
    const snapshot = await tx.get(request);
    const fingerprint = JSON.stringify({action, ...input});
    if (snapshot.exists && snapshot.data().fingerprint !== fingerprint) {
      throw new BookingError('invalid-argument', 'This request ID was already used for a different action.');
    }
    return {result: snapshot.exists ? snapshot.data().result : null, fingerprint};
  }

  function cache(tx, request, fingerprint, result, now) {
    tx.create(request, {fingerprint, result, expiresAt: Timestamp.fromMillis(now + 7 * 86400000)});
    return result;
  }

  async function oldSession(tx, machine, allowMissing = false) {
    if (!machine.activeSessionId) return null;
    const sessionRef = ref('sessions', machine.activeSessionId);
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists) {
      if (!allowMissing) throw new BookingError('failed-precondition', 'The machine needs administrator reconciliation.');
      const danglingGuards = await tx.get(db.collection('userLeases').where('sessionId', '==', sessionRef.id));
      return {sessionRef, session: null, danglingGuards};
    }
    const session = sessionSnap.data();
    const guardRef = ref('userLeases', session.ownerUid);
    const guard = await tx.get(guardRef);
    return {sessionRef, session, guardRef, guard};
  }

  function releaseOld(tx, old, status, now) {
    if (!old) return;
    if (old.danglingGuards) {
      for (const guard of old.danglingGuards.docs) tx.set(guard.ref, {sessionId: null, endsAt: 0});
      return;
    }
    if (old.session.status === 'active') tx.update(old.sessionRef,
      {status, endedAt: now, version: old.session.version + 1});
    if (old.guard.exists && old.guard.data().sessionId === old.sessionRef.id) {
      tx.set(old.guardRef, {sessionId: null, endsAt: 0});
    }
  }

  return {
    async book(actor, input) {
      const request = requestRef(actor, input);
      const machineRef = ref('machines', docId(input.machineId, 'Machine ID'));
      const minutes = duration(input.durationMinutes);
      const sessionRef = ref('sessions', randomUUID());
      const guardRef = ref('userLeases', actor.uid);
      return db.runTransaction(async tx => {
        const remembered = await cached(tx, request, 'book', input);
        if (remembered.result) return remembered.result;
        const now = clock();
        const [machineSnap, guardSnap] = await Promise.all([tx.get(machineRef), tx.get(guardRef)]);
        if (!machineSnap.exists) throw new BookingError('not-found', 'Machine not found.');
        const machine = machineSnap.data();
        checkVersion(machine.version, input.expectedVersion);
        if (machine.status !== 'online') throw new BookingError('failed-precondition', 'This machine is under maintenance.');
        if (machine.activeSessionId && machine.activeEndsAt > now) throw new BookingError('already-exists', 'This machine is already booked.');
        if (guardSnap.exists && guardSnap.data().sessionId && guardSnap.data().endsAt > now) {
          throw new BookingError('already-exists', 'You already have an active session.');
        }
        const old = await oldSession(tx, machine);
        // Every transaction read happens before any writes.
        releaseOld(tx, old, 'expired', now);
        const session = {machineId: machineRef.id, ownerUid: actor.uid,
          ownerName: String(actor.name || 'Resident').slice(0, 80), status: 'active',
          startedAt: now, endsAt: now + minutes * MINUTE, durationMinutes: minutes,
          extensionMinutes: 0, version: 0};
        tx.create(sessionRef, session);
        tx.update(machineRef, {activeSessionId: sessionRef.id, activeEndsAt: session.endsAt, version: machine.version + 1});
        tx.set(guardRef, {sessionId: sessionRef.id, endsAt: session.endsAt});
        audit(tx, actor, 'book', machineRef.id, sessionRef.id, '', now);
        return cache(tx, request, remembered.fingerprint, {id: sessionRef.id, ...session}, now);
      });
    },

    async extend(actor, input) {
      const request = requestRef(actor, input);
      const sessionRef = ref('sessions', docId(input.sessionId, 'Session ID'));
      return db.runTransaction(async tx => {
        const remembered = await cached(tx, request, 'extend', input);
        if (remembered.result) return remembered.result;
        const now = clock(), sessionSnap = await tx.get(sessionRef);
        if (!sessionSnap.exists) throw new BookingError('not-found', 'Session not found.');
        const session = sessionSnap.data();
        if (session.ownerUid !== actor.uid) throw new BookingError('permission-denied', 'This session belongs to another resident.');
        checkVersion(session.version, input.expectedVersion);
        if (session.status !== 'active' || session.endsAt <= now || session.extensionMinutes >= 15) {
          throw new BookingError('failed-precondition', 'Only an active session may be extended once by 15 minutes.');
        }
        const machineRef = ref('machines', session.machineId), machineSnap = await tx.get(machineRef);
        const guardRef = ref('userLeases', actor.uid), guardSnap = await tx.get(guardRef);
        if (!machineSnap.exists || machineSnap.data().activeSessionId !== sessionRef.id ||
            !guardSnap.exists || guardSnap.data().sessionId !== sessionRef.id) {
          throw new BookingError('failed-precondition', 'Session state is inconsistent. Please report the machine.');
        }
        const next = {...session, endsAt: session.endsAt + 15 * MINUTE, extensionMinutes: 15, version: session.version + 1};
        tx.update(sessionRef, next);
        tx.update(machineRef, {activeEndsAt: next.endsAt, version: machineSnap.data().version + 1});
        tx.set(guardRef, {sessionId: sessionRef.id, endsAt: next.endsAt});
        audit(tx, actor, 'extend', machineRef.id, sessionRef.id, '', now);
        return cache(tx, request, remembered.fingerprint, {id: sessionRef.id, ...next}, now);
      });
    },

    async finish(actor, input) {
      const request = requestRef(actor, input);
      const sessionRef = ref('sessions', docId(input.sessionId, 'Session ID'));
      return db.runTransaction(async tx => {
        const remembered = await cached(tx, request, 'finish', input);
        if (remembered.result) return remembered.result;
        const now = clock(), snapshot = await tx.get(sessionRef);
        if (!snapshot.exists) throw new BookingError('not-found', 'Session not found.');
        const session = snapshot.data();
        if (session.ownerUid !== actor.uid) throw new BookingError('permission-denied', 'This session belongs to another resident.');
        checkVersion(session.version, input.expectedVersion);
        if (session.status !== 'active') throw new BookingError('failed-precondition', 'This session is already closed.');
        const machineRef = ref('machines', session.machineId), machineSnap = await tx.get(machineRef);
        const guardRef = ref('userLeases', actor.uid), guardSnap = await tx.get(guardRef);
        if (!machineSnap.exists || machineSnap.data().activeSessionId !== sessionRef.id) throw new BookingError('aborted', 'The machine now has a different session.');
        releaseOld(tx, {sessionRef, session, guardRef, guard: guardSnap}, 'completed', now);
        tx.update(machineRef, {activeSessionId: null, activeEndsAt: 0, version: machineSnap.data().version + 1});
        audit(tx, actor, 'finish', machineRef.id, sessionRef.id, '', now);
        return cache(tx, request, remembered.fingerprint, {id: sessionRef.id, status: 'completed'}, now);
      });
    },

    async maintenance(actor, input) {
      requireAdmin(actor);
      const request = requestRef(actor, input), machineRef = ref('machines', docId(input.machineId));
      if (typeof input.enabled !== 'boolean') throw new BookingError('invalid-argument', 'Maintenance status must be true or false.');
      const detail = reason(input.reason);
      return db.runTransaction(async tx => {
        const remembered = await cached(tx, request, 'maintenance', input);
        if (remembered.result) return remembered.result;
        const now = clock(), snap = await tx.get(machineRef);
        if (!snap.exists) throw new BookingError('not-found', 'Machine not found.');
        const machine = snap.data();
        checkVersion(machine.version, input.expectedVersion);
        if (machine.activeSessionId && machine.activeEndsAt > now) throw new BookingError('failed-precondition', 'Resolve the active session before changing maintenance status.');
        const old = await oldSession(tx, machine);
        releaseOld(tx, old, 'expired', now);
        tx.update(machineRef, {status: input.enabled ? 'maintenance' : 'online', activeSessionId: null,
          activeEndsAt: 0, version: machine.version + 1});
        audit(tx, actor, 'maintenance', machineRef.id, old?.sessionRef.id, detail, now);
        return cache(tx, request, remembered.fingerprint, {id: machineRef.id, version: machine.version + 1}, now);
      });
    },

    async resolve(actor, input) {
      requireAdmin(actor);
      const request = requestRef(actor, input), machineRef = ref('machines', docId(input.machineId));
      const detail = reason(input.reason);
      return db.runTransaction(async tx => {
        const remembered = await cached(tx, request, 'resolve', input);
        if (remembered.result) return remembered.result;
        const now = clock(), snap = await tx.get(machineRef);
        if (!snap.exists) throw new BookingError('not-found', 'Machine not found.');
        const machine = snap.data();
        checkVersion(machine.version, input.expectedVersion);
        const old = await oldSession(tx, machine, true);
        releaseOld(tx, old, 'resolved', now);
        tx.update(machineRef, {activeSessionId: null, activeEndsAt: 0, version: machine.version + 1});
        audit(tx, actor, 'resolve', machineRef.id, old?.sessionRef.id, detail, now);
        return cache(tx, request, remembered.fingerprint, {id: machineRef.id, version: machine.version + 1}, now);
      });
    },

    async report(actor, input) {
      const request = requestRef(actor, input), machineRef = ref('machines', docId(input.machineId));
      const detail = reason(input.reason), reportRef = ref('reports', randomUUID());
      return db.runTransaction(async tx => {
        const remembered = await cached(tx, request, 'report', input);
        if (remembered.result) return remembered.result;
        if (!(await tx.get(machineRef)).exists) throw new BookingError('not-found', 'Machine not found.');
        const now = clock();
        tx.create(reportRef, {machineId: machineRef.id, ownerUid: actor.uid, reason: detail,
          status: 'open', createdAt: now});
        return cache(tx, request, remembered.fingerprint, {id: reportRef.id}, now);
      });
    },

    async resolveReport(actor, input) {
      requireAdmin(actor);
      const request = requestRef(actor, input), reportRef = ref('reports', docId(input.reportId));
      const detail = reason(input.reason);
      return db.runTransaction(async tx => {
        const remembered = await cached(tx, request, 'resolveReport', input);
        if (remembered.result) return remembered.result;
        const snap = await tx.get(reportRef), now = clock();
        if (!snap.exists) throw new BookingError('not-found', 'Report not found.');
        tx.update(reportRef, {status: 'resolved', resolvedBy: actor.uid, resolution: detail, resolvedAt: now});
        audit(tx, actor, 'resolve-report', snap.data().machineId, null, detail, now);
        return cache(tx, request, remembered.fingerprint, {id: reportRef.id, status: 'resolved'}, now);
      });
    },

    async expireSessions() {
      const due = await db.collection('sessions').where('status', '==', 'active').where('endsAt', '<=', clock()).limit(100).get();
      for (const sessionDoc of due.docs) {
        await db.runTransaction(async tx => {
          const fresh = await tx.get(sessionDoc.ref);
          if (!fresh.exists || fresh.data().status !== 'active' || fresh.data().endsAt > clock()) return;
          const session = fresh.data(), now = clock();
          const machineRef = ref('machines', session.machineId), machineSnap = await tx.get(machineRef);
          const guardRef = ref('userLeases', session.ownerUid), guard = await tx.get(guardRef);
          releaseOld(tx, {sessionRef: fresh.ref, session, guardRef, guard}, 'expired', now);
          if (machineSnap.exists && machineSnap.data().activeSessionId === fresh.id) tx.update(machineRef,
            {activeSessionId: null, activeEndsAt: 0, version: machineSnap.data().version + 1});
        });
      }
      return due.size;
    }
  };
}
