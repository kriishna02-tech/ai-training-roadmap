import {after, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initializeApp, deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {createService} from '../src/service.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Run with npm run test:emulator; live Firestore is never used by tests.');
const projectId = 'demo-washbook';
const app = initializeApp({projectId}, 'integration-test'), db = getFirestore(app);
let now;
const service = createService(db, () => now);
const resident = uid => ({uid, name: uid, isAdmin: false});
const admin = {uid: 'admin', name: 'Admin', isAdmin: true};
const request = values => ({requestId: randomUUID(), ...values});
const book = (machineId = 'wm-01', version = 0) => request({machineId, expectedVersion: version, durationMinutes: 45});

beforeEach(async () => {
  now = Date.now();
  const cleared = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, {method: 'DELETE'});
  assert.equal(cleared.status, 200);
  await Promise.all(['wm-01','wm-02'].map(id => db.collection('machines').doc(id).set(
    {name:id.toUpperCase(),floor:'Ground floor',status:'online',activeSessionId:null,activeEndsAt:0,version:0})));
});
after(async () => {await db.terminate(); await deleteApp(app);});

test('simultaneous reservations grant exactly one machine claim', async () => {
  const results = await Promise.allSettled(Array.from({length: 8}, (_,i) => service.book(resident(`resident-${i}`), book())));
  const successes = results.filter(result => result.status === 'fulfilled');
  assert.equal(successes.length, 1);
  assert.equal((await db.collection('sessions').get()).size, 1);
  const machine = (await db.collection('machines').doc('wm-01').get()).data();
  assert.equal(machine.activeSessionId, successes[0].value.id);
});

test('one resident racing two machines receives only one active session', async () => {
  const user = resident('same-resident');
  const results = await Promise.allSettled([service.book(user, book('wm-01')), service.book(user, book('wm-02'))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length, 1);
  assert.equal((await db.collection('sessions').get()).size, 1);
});

test('stale extensions cannot add time twice and a second extension is rejected', async () => {
  const user = resident('owner'), session = await service.book(user, book());
  const input = {sessionId:session.id, expectedVersion:0};
  const results = await Promise.allSettled([service.extend(user, request(input)), service.extend(user, request(input))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length, 1);
  const updated = (await db.collection('sessions').doc(session.id).get()).data();
  assert.equal(updated.endsAt, session.endsAt + 15 * 60000);
  await assert.rejects(service.extend(user, request({...input, expectedVersion:1})), error=>error.code==='failed-precondition');
});

test('expired reservations can be reclaimed and stale release cannot end the replacement', async () => {
  const first = await service.book(resident('first-owner'), book());
  now = first.endsAt + 1;
  await assert.rejects(service.extend(resident('first-owner'), request({sessionId:first.id,expectedVersion:0})), error=>error.code==='failed-precondition');
  const second = await service.book(resident('second-owner'), book('wm-01',1));
  assert.equal((await db.collection('sessions').doc(first.id).get()).data().status,'expired');
  assert.equal((await db.collection('userLeases').doc('first-owner').get()).data().sessionId,null);
  await assert.rejects(service.finish(resident('first-owner'), request({sessionId:first.id,expectedVersion:0})), error=>error.code==='aborted');
  assert.equal((await db.collection('machines').doc('wm-01').get()).data().activeSessionId,second.id);
});

test('retries with the same request ID return the same result', async () => {
  const user = resident('owner'), input = book();
  const first = await service.book(user,input), second = await service.book(user,input);
  assert.equal(first.id,second.id);
  assert.equal((await db.collection('sessions').get()).size,1);
  await assert.rejects(service.book(user,{...input,machineId:'wm-02'}), error=>error.code==='invalid-argument');
});

test('only the owner can finish a session and release its machine', async () => {
  const owner=resident('owner'), session=await service.book(owner,book());
  await assert.rejects(service.finish(resident('intruder'),request({sessionId:session.id,expectedVersion:0})), error=>error.code==='permission-denied');
  await service.finish(owner,request({sessionId:session.id,expectedVersion:0}));
  assert.equal((await db.collection('machines').doc('wm-01').get()).data().activeSessionId,null);
  assert.equal((await db.collection('userLeases').doc('owner').get()).data().sessionId,null);
});

test('administrator resolution and maintenance are audited and enforced', async () => {
  const owner=resident('owner'), session=await service.book(owner,book());
  await assert.rejects(service.maintenance(admin,request({machineId:'wm-01',expectedVersion:1,enabled:true,reason:'Broken drum'})),error=>error.code==='failed-precondition');
  await service.resolve(admin,request({machineId:'wm-01',expectedVersion:1,reason:'Resident reported a failed wash'}));
  assert.equal((await db.collection('sessions').doc(session.id).get()).data().status,'resolved');
  await service.maintenance(admin,request({machineId:'wm-01',expectedVersion:2,enabled:true,reason:'Broken drum'}));
  await assert.rejects(service.book(owner,book('wm-01',3)),error=>error.code==='failed-precondition');
  assert.ok((await db.collection('audit').get()).size>=3);
  const report=await service.report(owner,request({machineId:'wm-01',reason:'The machine stopped spinning'}));
  await assert.rejects(service.resolveReport(owner,request({reportId:report.id,reason:'Fixed now'})),error=>error.code==='permission-denied');
  await service.resolveReport(admin,request({reportId:report.id,reason:'Technician has replaced the belt'}));
  assert.equal((await db.collection('reports').doc(report.id).get()).data().status,'resolved');
});

test('scheduled expiry does not clear a newer machine or user lease', async () => {
  const owner=resident('owner'), old=await service.book(owner,book());
  now=old.endsAt+1;
  const newer='newer-session';
  await db.collection('machines').doc('wm-01').update({activeSessionId:newer,activeEndsAt:now+60000,version:2});
  await db.collection('userLeases').doc(owner.uid).set({sessionId:newer,endsAt:now+60000});
  assert.equal(await service.expireSessions(),1);
  assert.equal((await db.collection('sessions').doc(old.id).get()).data().status,'expired');
  assert.equal((await db.collection('machines').doc('wm-01').get()).data().activeSessionId,newer);
  assert.equal((await db.collection('userLeases').doc(owner.uid).get()).data().sessionId,newer);
});

test('administrator can reconcile a missing session record and its dangling user lease', async () => {
  await db.collection('machines').doc('wm-01').update({activeSessionId:'missing-session',activeEndsAt:now+60000,version:1});
  await db.collection('userLeases').doc('owner').set({sessionId:'missing-session',endsAt:now+60000});
  await service.resolve(admin,request({machineId:'wm-01',expectedVersion:1,reason:'The session record is missing'}));
  assert.equal((await db.collection('machines').doc('wm-01').get()).data().activeSessionId,null);
  assert.equal((await db.collection('userLeases').doc('owner').get()).data().sessionId,null);
});
