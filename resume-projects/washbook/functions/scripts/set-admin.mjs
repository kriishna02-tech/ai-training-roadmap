import {initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';

const [uid,projectId]=process.argv.slice(2);
if(!uid||!projectId) throw Error('Usage: node functions/scripts/set-admin.mjs UID PROJECT_ID. Uses Application Default Credentials or FIREBASE_AUTH_EMULATOR_HOST.');
initializeApp({projectId});
const auth=getAuth(), user=await auth.getUser(uid);
await auth.setCustomUserClaims(uid,{...user.customClaims,admin:true});
console.log('Admin claim granted. Sign out and sign in again to refresh the ID token.');
