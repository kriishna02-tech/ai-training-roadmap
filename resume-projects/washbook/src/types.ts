export interface Resident { uid: string; name: string; isAdmin: boolean }
export interface Machine { id: string; name: string; floor: string; status: 'online' | 'maintenance'; activeSessionId: string | null; activeEndsAt: number; version: number }
export interface Session { id: string; machineId: string; ownerUid: string; ownerName: string; status: 'active' | 'completed' | 'expired' | 'resolved'; startedAt: number; endsAt: number; durationMinutes: number; extensionMinutes: number; version: number }
export interface Report { id: string; machineId: string; ownerUid: string; reason: string; status: 'open' | 'resolved'; createdAt: number }
export interface Snapshot { user: Resident | null; machines: Machine[]; sessions: Session[]; reports: Report[]; error: string; loading: boolean }
export type Action = 'bookMachine' | 'extendSession' | 'finishSession' | 'setMaintenance' | 'resolveMachine' | 'reportMachine' | 'resolveReport';
export interface Gateway { demo: boolean; emulator: boolean; subscribe(listener: (state: Snapshot) => void): () => void; signIn(): Promise<void>; signOut(): Promise<void>; act(name: Action, payload: Record<string, unknown>): Promise<void>; toggleDemoAdmin(): void }
