import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';

if(!process.env.FIRESTORE_EMULATOR_HOST) throw Error('This seed script only writes to the Firestore emulator. Set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080.');
initializeApp({projectId:'demo-washbook'});
const db=getFirestore();
for(let i=1;i<=4;i++){
  const reference=db.collection('machines').doc(`wm-0${i}`);
  const existing=await reference.get();
  if(existing.exists) continue;
  await reference.create({name:`WM-0${i}`,floor:i<=2?'Ground floor':'First floor',status:i===4?'maintenance':'online',activeSessionId:null,activeEndsAt:0,version:0});
}
console.log('Emulator laundry room is ready. Existing machines were preserved.');
await db.terminate();
