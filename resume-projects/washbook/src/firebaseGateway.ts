import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, onIdTokenChanged, signInAnonymously, signInWithPopup, signOut } from 'firebase/auth';
import { collection, connectFirestoreEmulator, getFirestore, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import type { Action, Gateway, Machine, Report, Session, Snapshot } from './types';

const empty = (): Snapshot => ({user: null, machines: [], sessions: [], reports: [], error: '', loading: false});

export function firebaseGateway(): Gateway {
  const env = import.meta.env, emulator = env.VITE_USE_EMULATORS === 'true';
  const config = {apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, projectId: env.VITE_FIREBASE_PROJECT_ID, appId: env.VITE_FIREBASE_APP_ID};
  if (Object.values(config).some(value => !value) || (!emulator && config.projectId.startsWith('demo-'))) throw Error('Set your Firebase project configuration or use VITE_DEMO_MODE=true.');
  const app = initializeApp(config), auth = getAuth(app), db = getFirestore(app), functions = getFunctions(app, 'us-central1');
  if (emulator) { connectAuthEmulator(auth, 'http://127.0.0.1:9099', {disableWarnings: true}); connectFirestoreEmulator(db, '127.0.0.1', 8080); connectFunctionsEmulator(functions, '127.0.0.1', 5001); }
  return {
    demo: false, emulator,
    subscribe(listener) {
      let state = empty(), stops: (() => void)[] = [], generation = 0;
      const emit = () => listener({...state});
      const stopAuth = onIdTokenChanged(auth, async current => {
        const token = ++generation;
        stops.forEach(stop => stop()); stops = [];
        state = {...empty(), loading: !!current}; emit();
        if (!current) return;
        try {
          const claims = await current.getIdTokenResult();
          if (token !== generation) return;
          state.user = {uid: current.uid, name: current.displayName || (emulator ? 'Emulator resident' : 'Resident'), isAdmin: claims.claims.admin === true};
          const fail = (error: Error) => {state.error = error.message; state.loading = false; emit();};
          stops.push(onSnapshot(query(collection(db, 'machines'), orderBy('name')), snapshot => {state.machines = snapshot.docs.map(d => ({...d.data(), id: d.id} as Machine)); state.loading = false; emit();}, fail));
          stops.push(onSnapshot(query(collection(db, 'sessions'), where('ownerUid', '==', current.uid), orderBy('startedAt', 'desc'), limit(30)), snapshot => {state.sessions = snapshot.docs.map(d => ({...d.data(), id: d.id} as Session)); emit();}, fail));
          if (state.user.isAdmin) stops.push(onSnapshot(query(collection(db, 'reports'), where('status', '==', 'open')), snapshot => {state.reports = snapshot.docs.map(d => ({...d.data(), id: d.id} as Report)); emit();}, fail));
          emit();
        } catch (error) { if (token === generation) {state.error = error instanceof Error ? error.message : 'Could not load account.'; state.loading = false; emit();} }
      });
      return () => { generation++; stopAuth(); stops.forEach(stop => stop()); };
    },
    async signIn() { if (emulator) await signInAnonymously(auth); else await signInWithPopup(auth, new GoogleAuthProvider()); },
    async signOut() { await signOut(auth); },
    async act(name: Action, payload) { await httpsCallable(functions, name)({...payload, requestId: crypto.randomUUID()}); },
    toggleDemoAdmin() {}
  };
}
