import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {initializeApp as adminApp, deleteApp as deleteAdminApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {initializeApp, deleteApp} from 'firebase/app';
import {getAuth, connectAuthEmulator, signInAnonymously, signOut} from 'firebase/auth';
import {getFunctions, connectFunctionsEmulator, httpsCallable} from 'firebase/functions';

if(!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw Error('Run through the local Firebase emulators; these tests never contact production.');
}
process.env.GCLOUD_PROJECT='demo-washbook';
// Mount the actual exported HTTPS handlers over TCP. Authentication remains
// enabled and verifies tokens against the local Auth emulator. This exercises
// callable middleware without depending on the CLI's Unix-socket transport.
const endpoints=await import('../functions/src/index.js');
const host=express();
host.use(express.json({limit:'64kb'}));
for(const name of ['bookMachine','extendSession','finishSession','setMaintenance','resolveMachine','reportMachine','resolveReport']) {
  host.post(`/demo-washbook/us-central1/${name}`,endpoints[name]);
}
let server;
const privileged=adminApp({projectId:'demo-washbook'},'callable-tests'), db=getFirestore(privileged);
const app=initializeApp({apiKey:'demo-api-key',projectId:'demo-washbook',appId:'demo-app-id'},'web-client-tests');
const auth=getAuth(app), functions=getFunctions(app,'us-central1');
connectAuthEmulator(auth,`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,{disableWarnings:true});
const invoke=(name,values)=>httpsCallable(functions,name,{timeout:15000})({requestId:randomUUID(),...values});

before(async()=>{
  server=await new Promise((resolve,reject)=>{
    const listener=host.listen(0,'127.0.0.1',()=>resolve(listener));
    listener.once('error',reject);
  });
  connectFunctionsEmulator(functions,'127.0.0.1',server.address().port);
  await db.collection('machines').doc('wm-callable').set({name:'WM-CALLABLE',floor:'Ground floor',status:'online',activeSessionId:null,activeEndsAt:0,version:0});
});
after(async()=>{
  await signOut(auth);await deleteApp(app);await db.terminate();await deleteAdminApp(privileged);
  if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Firebase web client authenticates and calls the full booking lifecycle',{timeout:30000},async()=>{
  const user=(await signInAnonymously(auth)).user;
  const booked=(await invoke('bookMachine',{machineId:'wm-callable',expectedVersion:0,durationMinutes:45})).data;
  assert.equal(booked.ownerUid,user.uid);
  assert.equal((await db.collection('machines').doc('wm-callable').get()).data().activeSessionId,booked.id);
  const extended=(await invoke('extendSession',{sessionId:booked.id,expectedVersion:0})).data;
  assert.equal(extended.extensionMinutes,15);
  assert.equal(extended.endsAt,booked.endsAt+15*60000);
  await invoke('finishSession',{sessionId:booked.id,expectedVersion:1});
  assert.equal((await db.collection('sessions').doc(booked.id).get()).data().status,'completed');
  assert.equal((await db.collection('machines').doc('wm-callable').get()).data().activeSessionId,null);
});

test('callable middleware rejects an unauthenticated web client',{timeout:30000},async()=>{
  await signOut(auth);
  await assert.rejects(invoke('bookMachine',{machineId:'wm-callable',expectedVersion:2,durationMinutes:45}),error=>error.code==='functions/unauthenticated');
});
