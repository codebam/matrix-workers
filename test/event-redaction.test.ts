/**
 * Serve-side redaction (spec redaction algorithm at the client boundary):
 * computeRedactedContent prunes per the room version's keep rules, and
 * applyEventRedaction stores the pruned copy + unsigned.redacted_because
 * while leaving the original `content` untouched (federation hashes and
 * signatures stay valid).
 */
import { describe, expect, it, vi } from 'vitest';
import { computeRedactedContent } from '../src/services/room-versions';
import { applyEventRedaction } from '../src/services/event-redaction';

describe('computeRedactedContent', () => {
  it('member events keep membership (and v11+ extras)', () => {
    const content = {
      membership: 'join',
      displayname: 'Alice',
      avatar_url: 'mxc://x',
    };
    expect(computeRedactedContent('m.room.member', content, '10')).toEqual({
      membership: 'join',
    });
    // v11+ also keeps third_party_invite.
    expect(
      computeRedactedContent('m.room.member', { ...content, third_party_invite: { signed: {} } }, '11')
    ).toEqual({ membership: 'join', third_party_invite: { signed: {} } });
  });

  it('messages lose everything', () => {
    expect(
      computeRedactedContent('m.room.message', { body: 'secret', msgtype: 'm.text' }, '10')
    ).toEqual({});
  });

  it('power levels keep their auth-relevant fields', () => {
    const pruned = computeRedactedContent(
      'm.room.power_levels',
      { users_default: 0, users: { '@a:b': 50 }, events_default: 0, ban: 50, history_visibility: 'shared' },
      '10'
    );
    expect(pruned).toEqual({ users_default: 0, users: { '@a:b': 50 }, events_default: 0, ban: 50 });
  });

  it('redaction events keep redacts on v11+', () => {
    expect(computeRedactedContent('m.room.redaction', { redacts: '$x', reason: 'r' }, '12')).toEqual({
      redacts: '$x',
    });
    // v10's keep list has no redaction entry at all.
    expect(computeRedactedContent('m.room.redaction', { redacts: '$x' }, '10')).toEqual({});
  });

  it('unknown room versions and non-object content prune to empty', () => {
    expect(computeRedactedContent('m.room.message', { body: 'x' }, '99-nope')).toEqual({});
    expect(computeRedactedContent('m.room.message', null, '10')).toEqual({});
    expect(computeRedactedContent('m.room.message', 'string?', '10')).toEqual({});
  });
});

describe('applyEventRedaction', () => {
  function dbWith(row: { event_type: string; content: string; unsigned: string | null } | null) {
    const updates: Array<{ sql: string; args: unknown[] }> = [];
    return {
      updates,
      db: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first<T>() {
                  if (sql.includes('SELECT event_type, content, unsigned FROM events')) {
                    return (row ?? null) as T;
                  }
                  return null as T;
                },
                async run() {
                  updates.push({ sql, args });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        },
      } as unknown as D1Database,
    };
  }

  it('marks redacted_because, stores pruned content and merges unsigned', async () => {
    const { db, updates } = dbWith({
      event_type: 'm.room.message',
      content: JSON.stringify({ body: 'spam', msgtype: 'm.text' }),
      unsigned: JSON.stringify({ transaction_id: 'tx1' }),
    });
    await applyEventRedaction(
      db,
      '!r:example.com',
      '10',
      {
        eventId: '$redaction:example.com',
        sender: '@mod:example.com',
        originServerTs: 1_700_000_000_000,
        content: { redacts: '$target:example.com', reason: 'spam' },
      },
      '$target:example.com'
    );

    expect(updates).toHaveLength(1);
    const upd = updates[0];
    expect(upd.sql).toContain('redacted_because');
    expect(upd.args[0]).toBe('$redaction:example.com');
    expect(JSON.parse(upd.args[1] as string)).toEqual({}); // pruned message content
    const unsigned = JSON.parse(upd.args[2] as string);
    expect(unsigned.transaction_id).toBe('tx1'); // preserved, not replaced
    expect(unsigned.redacted_because).toMatchObject({
      type: 'm.room.redaction',
      event_id: '$redaction:example.com',
      sender: '@mod:example.com',
      content: { redacts: '$target:example.com', reason: 'spam' },
    });
  });

  it('member targets keep membership in the pruned copy', async () => {
    const { db, updates } = dbWith({
      event_type: 'm.room.member',
      content: JSON.stringify({ membership: 'join', displayname: 'Bob' }),
      unsigned: null,
    });
    await applyEventRedaction(
      db,
      '!r:example.com',
      '12',
      { eventId: '$r:example.com', sender: '@m:example.com', originServerTs: 1, content: { redacts: '$t' } },
      '$t'
    );
    expect(JSON.parse(updates[0].args[1] as string)).toEqual({ membership: 'join' });
  });

  it('does nothing when the target row is missing', async () => {
    const { db, updates } = dbWith(null);
    await applyEventRedaction(
      db,
      '!r:example.com',
      '10',
      { eventId: '$r', sender: '@m:example.com', originServerTs: 1, content: {} },
      '$missing'
    );
    expect(updates).toHaveLength(0);
  });

  it('survives unparseable stored content (no update crash)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = dbWith({
      event_type: 'm.room.message',
      content: '{oops',
      unsigned: null,
    });
    await applyEventRedaction(
      db,
      '!r:example.com',
      '10',
      { eventId: '$r', sender: '@m:example.com', originServerTs: 1, content: {} },
      '$t'
    );
    warn.mockRestore();
  });
});
