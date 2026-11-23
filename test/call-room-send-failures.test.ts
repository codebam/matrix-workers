import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallRoomDurableObject, MAX_SEND_FAILURES } from '../src/durable-objects/call-room';
import type { Env } from '../src/types';

// Issue 005.6: evict participants whose sends keep failing.

class FakeStorage {
  map = new Map<string, unknown>();
  async get(key: string): Promise<unknown> { return this.map.get(key); }
  async put(key: string, value: unknown): Promise<void> { this.map.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
  async deleteAll(): Promise<void> { this.map.clear(); }
  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of [...this.map.entries()].sort()) {
      if (k.startsWith(options.prefix)) out.set(k, v as T);
    }
    return out;
  }
}

class FakeWebSocket {
  attachment: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  serializeAttachment(value: unknown): void { this.attachment = structuredClone(value); }
  deserializeAttachment(): unknown { return this.attachment; }
  send(data: string): void { this.sent.push(data); }
  close(code: number, reason: string): void { this.closed = { code, reason }; }
}

class FakeState {
  storage = new FakeStorage();
  sockets: FakeWebSocket[] = [];
  getWebSockets(): FakeWebSocket[] { return this.sockets; }
  acceptWebSocket(ws: FakeWebSocket): void { this.sockets.push(ws); }
  setWebSocketAutoResponse(): void {}
  blockConcurrencyWhile(cb: () => Promise<void>): Promise<void> { return cb(); }
}

function makeRoom(state: FakeState): any {
  return new CallRoomDurableObject(state as unknown as any, {} as Env);
}

function storedParticipant(userId: string, deviceId: string) {
  return {
    oderId: userId,
    deviceId,
    sessionId: `session-${userId}`,
    tracks: {},
    joinedAt: 1752900000000,
  };
}

describe('CallRoom send failures (issue 005.6)', () => {
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('increments the failure counter on a failed send', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));

    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    wsB.send = () => { throw new Error('broken pipe'); };
    state.sockets = [wsA, wsB];

    const room = makeRoom(state);
    await room.loadParticipants();

    await room.broadcast({ type: 'ping' });

    expect(room.sendFailures.get('u2|d2')).toBe(1);
    expect(room.participants.has('u2|d2')).toBe(true);
  });

  it('resets the failure counter on a successful send', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));

    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    state.sockets = [wsA, wsB];

    const room = makeRoom(state);
    await room.loadParticipants();

    // Pre-seed a failure count
    room.sendFailures.set('u2|d2', 2);

    await room.broadcast({ type: 'ping' });

    expect(room.sendFailures.has('u2|d2')).toBe(false);
  });

  it('evicts a participant after MAX_SEND_FAILURES consecutive failures', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    await state.storage.put('participant:u3|d3', storedParticipant('u3', 'd3'));

    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    wsB.send = () => { throw new Error('peer gone'); };
    const wsC = new FakeWebSocket();
    wsC.serializeAttachment({ participantKey: 'u3|d3' });
    state.sockets = [wsA, wsB, wsC];

    const room = makeRoom(state);
    await room.loadParticipants();

    for (let i = 0; i < MAX_SEND_FAILURES; i++) {
      await room.broadcast({ type: 'ping' });
    }

    // Evicted
    expect(room.participants.has('u2|d2')).toBe(false);
    expect(state.storage.map.has('participant:u2|d2')).toBe(false);
    expect(wsB.closed?.code).toBe(1000);
    expect(room.sendFailures.has('u2|d2')).toBe(false);

    // Other peers notified via participant_left
    const leftMsgs = wsC.sent.map((s: string) => JSON.parse(s)).filter((m: any) => m.type === 'participant_left');
    expect(leftMsgs.length).toBeGreaterThanOrEqual(1);
    expect(leftMsgs[0]).toMatchObject({ type: 'participant_left', oderId: 'u2', deviceId: 'd2' });

    // Logging occurred
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('keeps failures isolated: one failing socket does not abort the broadcast loop', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));
    await state.storage.put('participant:u2|d2', storedParticipant('u2', 'd2'));
    await state.storage.put('participant:u3|d3', storedParticipant('u3', 'd3'));

    const wsA = new FakeWebSocket();
    wsA.serializeAttachment({ participantKey: 'u1|d1' });
    const wsB = new FakeWebSocket();
    wsB.serializeAttachment({ participantKey: 'u2|d2' });
    wsB.send = () => { throw new Error('peer gone'); };
    const wsC = new FakeWebSocket();
    wsC.serializeAttachment({ participantKey: 'u3|d3' });
    state.sockets = [wsA, wsB, wsC];

    const room = makeRoom(state);
    await room.loadParticipants();

    // Single failure (below threshold) should not evict and should not abort delivery to wsC
    await room.broadcast({ type: 'ping' });

    expect(room.participants.has('u2|d2')).toBe(true);
    // wsC still received the message
    expect(wsC.sent).toHaveLength(1);
    expect(JSON.parse(wsC.sent[0]).type).toBe('ping');
  });

  it('direct send() with participantKey tracks failures and evicts at threshold', async () => {
    const state = new FakeState();
    await state.storage.put('participant:u1|d1', storedParticipant('u1', 'd1'));

    const ws = new FakeWebSocket();
    ws.serializeAttachment({ participantKey: 'u1|d1' });
    ws.send = () => { throw new Error('broken'); };
    state.sockets = [ws];

    const room = makeRoom(state);
    await room.loadParticipants();

    for (let i = 0; i < MAX_SEND_FAILURES; i++) {
      room.send(ws, { type: 'x' }, 'u1|d1');
    }

    // eviction is async (void), give it a tick
    await new Promise((r) => setTimeout(r, 0));
    // allow microtasks
    await Promise.resolve();

    expect(room.participants.has('u1|d1')).toBe(false);
    expect(state.storage.map.has('participant:u1|d1')).toBe(false);
  });
});