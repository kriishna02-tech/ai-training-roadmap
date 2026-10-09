import {after, before, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertFails, assertSucceeds, initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,getDoc,setDoc,collection,getDocs,query,where,updateDoc} from 'firebase/firestore';

if(!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Security rules tests require the local emulator.');
let environment;
before(async()=>{
  const [host,port]=process.env.FIRESTORE_EMULATOR_HOST.split(':');
  environment=await initializeTestEnvironment({projectId:'demo-washbook',firestore:{host,port:Number(port),rules:await readFile(new URL('../firestore.rules',import.meta.url),'utf8')}});
});
beforeEach(async()=>{
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    await setDoc(doc(db,'machines','wm-01'),{name:'WM-01',status:'online',version:0});
    await setDoc(doc(db,'sessions','session-1'),{ownerUid:'alice',status:'active'});
    await setDoc(doc(db,'userLeases','alice'),{sessionId:'session-1'});
    await setDoc(doc(db,'reports','report-1'),{ownerUid:'alice',reason:'Broken drum',status:'open'});
  });
});
after(async()=>{await environment?.cleanup();});

test('unauthenticated users cannot see machine or resident information',async()=>{
  const db=environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db,'machines','wm-01')));
  await assertFails(getDoc(doc(db,'sessions','session-1')));
});
test('resident sees availability and only their own sessions',async()=>{
  const alice=environment.authenticatedContext('alice').firestore(), bob=environment.authenticatedContext('bob').firestore();
  await assertSucceeds(getDoc(doc(alice,'machines','wm-01')));
  await assertSucceeds(getDoc(doc(alice,'sessions','session-1')));
  await assertFails(getDoc(doc(bob,'sessions','session-1')));
  const own=await assertSucceeds(getDocs(query(collection(alice,'sessions'),where('ownerUid','==','alice'))));
  assert.equal(own.size,1);
  await assertFails(getDocs(collection(alice,'sessions')));
});
test('client cannot bypass reservation transactions or forge sessions',async()=>{
  const db=environment.authenticatedContext('alice').firestore();
  await assertFails(updateDoc(doc(db,'machines','wm-01'),{activeSessionId:'forged'}));
  await assertFails(setDoc(doc(db,'sessions','forged'),{ownerUid:'alice',endsAt:9999999999999}));
  await assertFails(setDoc(doc(db,'userLeases','alice'),{sessionId:null}));
});
test('a resident cannot assign admin privileges or write audit records',async()=>{
  const db=environment.authenticatedContext('alice').firestore();
  await assertFails(setDoc(doc(db,'users','alice'),{admin:true}));
  await assertFails(setDoc(doc(db,'audit','forged'),{actorUid:'admin'}));
  await assertFails(setDoc(doc(db,'requests','fake'),{result:{approved:true}}));
});
test('reports are private and only administrator claims grant broader reads',async()=>{
  const alice=environment.authenticatedContext('alice').firestore(),bob=environment.authenticatedContext('bob').firestore(),admin=environment.authenticatedContext('admin',{admin:true}).firestore();
  await assertSucceeds(getDoc(doc(alice,'reports','report-1')));
  await assertFails(getDoc(doc(bob,'reports','report-1')));
  await assertSucceeds(getDoc(doc(admin,'reports','report-1')));
  await assertFails(updateDoc(doc(admin,'machines','wm-01'),{status:'maintenance'}));
});
