import type { Gateway, Machine, Report, Resident, Session, Snapshot } from './types';

const empty = (): Snapshot => ({user: null, machines: [], sessions: [], reports: [], error: '', loading: false});
const demoKey = 'washbook-demo-v1';

function seed() {
  const now = Date.now();
  const machines: Machine[] = [
    {id: 'wm-01', name: 'WM-01', floor: 'Ground floor', status: 'online', activeSessionId: null, activeEndsAt: 0, version: 0},
    {id: 'wm-02', name: 'WM-02', floor: 'Ground floor', status: 'online', activeSessionId: null, activeEndsAt: 0, version: 0},
    {id: 'wm-03', name: 'WM-03', floor: 'First floor', status: 'online', activeSessionId: 'sample-session', activeEndsAt: now + 17 * 60000, version: 1},
    {id: 'wm-04', name: 'WM-04', floor: 'First floor', status: 'maintenance', activeSessionId: null, activeEndsAt: 0, version: 1}
  ];
  const sessions: Session[] = [{id: 'sample-session', machineId: 'wm-03', ownerUid: 'sample-resident', ownerName: 'Another resident', status: 'active', startedAt: now - 28 * 60000, endsAt: now + 17 * 60000, durationMinutes: 45, extensionMinutes: 0, version: 0}];
  return {machines, sessions, reports: [] as Report[]};
}

function demoGateway(): Gateway {
  let user: Resident | null = null;
  const listeners = new Set<(state: Snapshot) => void>();
  function read() {
    try { const saved = localStorage.getItem(demoKey); if (saved) return JSON.parse(saved) as ReturnType<typeof seed>; } catch { /* recover corrupt demo data */ }
    const data = seed(); localStorage.setItem(demoKey, JSON.stringify(data)); return data;
  }
  function emit() { const data = read(); for (const fn of listeners) fn({...empty(), user, ...data, sessions: data.sessions.filter(s => s.ownerUid === user?.uid), reports: data.reports.filter(r => user?.isAdmin || r.ownerUid === user?.uid)}); }
  window.addEventListener('storage', event => { if (event.key === demoKey) emit(); });
  const api: Gateway = {
    demo: true, emulator: false,
    subscribe(fn) { listeners.add(fn); emit(); return () => { listeners.delete(fn); }; },
    async signIn() { user = {uid: 'demo-resident', name: 'Krishna Kumar', isAdmin: false}; emit(); },
    async signOut() { user = null; emit(); },
    toggleDemoAdmin() { if (user) user = {...user, isAdmin: !user.isAdmin}; emit(); },
    async act(action, input) {
      const update = () => {
        if (!user) throw Error('Sign in first.');
        const data = read(), now = Date.now();
        const machine = data.machines.find(m => m.id === input.machineId);
        const session = data.sessions.find(s => s.id === input.sessionId);
        const check = (version: number) => { if (version !== input.expectedVersion) throw Error('This changed. Refresh and try again.'); };
        if (['setMaintenance', 'resolveMachine', 'resolveReport'].includes(action) && !user.isAdmin) throw Error('Administrator access is required.');
        if (action === 'bookMachine') {
          if (!machine) throw Error('Machine not found.'); check(machine.version);
          if (machine.status === 'maintenance' || machine.activeEndsAt > now) throw Error('This machine is unavailable.');
          if (data.sessions.some(s => s.ownerUid === user!.uid && s.status === 'active' && s.endsAt > now)) throw Error('You already have an active session.');
          const minutes = Number(input.durationMinutes);
          if (![30, 45, 60].includes(minutes)) throw Error('Invalid session duration.');
          const previous = data.sessions.find(s => s.id === machine.activeSessionId);
          if (previous) {previous.status = 'expired'; previous.version++;}
          const next: Session = {id: crypto.randomUUID(), machineId: machine.id, ownerUid: user.uid, ownerName: user.name, status: 'active', startedAt: now, endsAt: now + minutes * 60000, durationMinutes: minutes, extensionMinutes: 0, version: 0};
          data.sessions.push(next); machine.activeSessionId = next.id; machine.activeEndsAt = next.endsAt; machine.version++;
        } else if (action === 'extendSession' || action === 'finishSession') {
          if (!session || session.ownerUid !== user.uid) throw Error('Session not found.'); check(session.version);
          if (session.status !== 'active') throw Error('Session is already closed.');
          const activeMachine = data.machines.find(m => m.id === session.machineId)!;
          if (activeMachine.activeSessionId !== session.id) throw Error('The machine has a different session.');
          if (action === 'extendSession') {
            if (session.extensionMinutes >= 15 || session.endsAt <= now) throw Error('An active session can be extended only once.');
            session.endsAt += 15 * 60000; session.extensionMinutes = 15; activeMachine.activeEndsAt = session.endsAt;
          } else {session.status = 'completed'; activeMachine.activeSessionId = null; activeMachine.activeEndsAt = 0;}
          session.version++; activeMachine.version++;
        } else if (action === 'setMaintenance' || action === 'resolveMachine') {
          if (!machine) throw Error('Machine not found.'); check(machine.version);
          if (action === 'setMaintenance' && machine.activeEndsAt > now) throw Error('Resolve the active session first.');
          const previous = data.sessions.find(s => s.id === machine.activeSessionId);
          if (previous) {previous.status = action === 'resolveMachine' ? 'resolved' : 'expired'; previous.version++;}
          machine.activeSessionId = null; machine.activeEndsAt = 0; machine.version++;
          if (action === 'setMaintenance') machine.status = input.enabled ? 'maintenance' : 'online';
        } else if (action === 'reportMachine') {
          if (!machine) throw Error('Machine not found.');
          data.reports.push({id: crypto.randomUUID(), machineId: machine.id, ownerUid: user.uid, reason: String(input.reason), status: 'open', createdAt: now});
        } else {
          const report = data.reports.find(r => r.id === input.reportId);
          if (!report) throw Error('Report not found.'); report.status = 'resolved';
        }
        localStorage.setItem(demoKey, JSON.stringify(data)); emit();
      };
      if (navigator.locks) await navigator.locks.request('washbook-demo', update); else update();
    }
  };
  return api;
}

export async function createGateway(): Promise<Gateway> {
  if (import.meta.env.VITE_DEMO_MODE !== 'false') return demoGateway();
  const {firebaseGateway} = await import('./firebaseGateway');
  return firebaseGateway();
}
