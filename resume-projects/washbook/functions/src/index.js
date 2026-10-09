import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createService } from './service.js';
import { BookingError } from './domain.js';

initializeApp();
const service = createService(getFirestore());

function callable(method) {
  return onCall({region: 'us-central1', maxInstances: 10}, async request => {
    const actor = request.auth ? {uid: request.auth.uid, name: request.auth.token.name,
      isAdmin: request.auth.token.admin === true} : null;
    try {
      return await service[method](actor, request.data || {});
    } catch (error) {
      if (error instanceof BookingError) throw new HttpsError(error.code, error.message);
      console.error('Booking operation failed', {method, code: error.code || 'unknown'});
      throw new HttpsError('internal', 'The operation could not be completed. Please retry.');
    }
  });
}

export const bookMachine = callable('book');
export const extendSession = callable('extend');
export const finishSession = callable('finish');
export const setMaintenance = callable('maintenance');
export const resolveMachine = callable('resolve');
export const reportMachine = callable('report');
export const resolveReport = callable('resolveReport');
export const expireSessions = onSchedule({schedule: 'every 1 minutes', region: 'us-central1', maxInstances: 1},
  () => service.expireSessions());
