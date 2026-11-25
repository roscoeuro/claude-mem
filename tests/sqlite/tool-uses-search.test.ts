import { describe, it, expect, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch, TOOL_USES_FTS_TRIGGER_NAMES } from '../../src/services/sqlite/SessionSearch.js';
import { ResultFormatter } from '../../src/services/worker/search/ResultFormatter.js';

// #4060 — the raw tool I/O search tier over tool_uses.tool_input / tool_response.

function input(overrides: Record<string, unknown> = {}) {
  return {
    toolUseId: 'toolu_01',
    contentSessionId: 'content-session-a',
    project: 'claude-mem',
    toolName: 'Bash',
    toolInput: '{"command":"npm test"}',
    toolResponse: '{"stdout":"all green"}',
    ...overrides,
  } as Parameters<SessionStore['upsertToolUse']>[0];
}

describe('SessionSearch.searchToolUses (#4060)', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  function open(): { store: SessionStore; search: SessionSearch } {
    store = new SessionStore(':memory:');
    return { store, search: new SessionSearch(store.db) };
  }

  it('creates the index and its sync triggers', () => {
    const { store } = open();
    const names = (store.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'tool_uses_%'").all() as { name: string }[])
      .map(row => row.name);
    expect(names).toContain('tool_uses_fts');
    for (const trigger of TOOL_USES_FTS_TRIGGER_NAMES) expect(names).toContain(trigger);
  });

  it('finds a term that only appears in a tool response', () => {
    const { store, search } = open();
    const id = store.upsertToolUse(input({ toolResponse: '{"stderr":"ECONNREFUSED 127.0.0.1:37777"}' }));
    store.upsertToolUse(input({ toolUseId: 'toolu_02', toolResponse: '{"stdout":"fine"}' }));

    const hits = search.searchToolUses('ECONNREFUSED');
    expect(hits.map(hit => hit.id)).toEqual([id!]);
    expect(hits[0].tool_name).toBe('Bash');
    expect(hits[0].snippet).toContain('[ECONNREFUSED]');
  });

  it('indexes rows written before the index existed (backfill)', () => {
    const store1 = new SessionStore(':memory:');
    store = store1;
    // Drop the index and its triggers, write a row, then let SessionSearch recreate it.
    store1.db.run('DROP TABLE IF EXISTS tool_uses_fts');
    for (const trigger of TOOL_USES_FTS_TRIGGER_NAMES) store1.db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    store1.upsertToolUse(input({ toolInput: '{"command":"kubectl rollout status"}' }));

    const search = new SessionSearch(store1.db);
    expect(search.searchToolUses('kubectl')).toHaveLength(1);
  });

  it('re-converges when the triggers went missing but the index survived', () => {
    const { store } = open();
    for (const trigger of TOOL_USES_FTS_TRIGGER_NAMES) store.db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    store.upsertToolUse(input({ toolResponse: '{"stdout":"walrus"}' }));

    const search = new SessionSearch(store.db);
    expect(search.searchToolUses('walrus')).toHaveLength(1);
    // Deleting the row must not corrupt the index now that triggers are back.
    store.db.run('DELETE FROM tool_uses');
    expect(search.searchToolUses('walrus')).toEqual([]);
  });

  it('follows upsert refreshes and deletes', () => {
    const { store, search } = open();
    store.upsertToolUse(input({ toolResponse: null }));
    expect(search.searchToolUses('quokka')).toEqual([]);

    // A replayed PostToolUse is the first to carry the response.
    store.upsertToolUse(input({ toolResponse: '{"stdout":"quokka"}' }));
    expect(search.searchToolUses('quokka')).toHaveLength(1);

    store.db.run('DELETE FROM tool_uses');
    expect(search.searchToolUses('quokka')).toEqual([]);
  });

  it('ANDs multi-word queries', () => {
    const { store, search } = open();
    store.upsertToolUse(input({ toolResponse: '{"stdout":"retry limit reached"}' }));
    store.upsertToolUse(input({ toolUseId: 'toolu_02', toolResponse: '{"stdout":"retry ok"}' }));
    expect(search.searchToolUses('retry limit')).toHaveLength(1);
  });

  it('scopes by project, platform source and date', () => {
    const { store, search } = open();
    store.upsertToolUse(input({ project: 'alpha', toolResponse: 'needle', createdAtEpoch: 1_000 }));
    store.upsertToolUse(input({ toolUseId: 'toolu_02', project: 'beta', toolResponse: 'needle', createdAtEpoch: 5_000 }));
    store.upsertToolUse(input({ toolUseId: 'toolu_03', project: 'alpha', platformSource: 'codex', toolResponse: 'needle', createdAtEpoch: 9_000 }));

    expect(search.searchToolUses('needle')).toHaveLength(3);
    expect(search.searchToolUses('needle', { project: 'ALPHA' })).toHaveLength(2);
    expect(search.searchToolUses('needle', { projects: ['beta'] })).toHaveLength(1);
    expect(search.searchToolUses('needle', { platformSource: 'codex' })).toHaveLength(1);
    expect(search.searchToolUses('needle', { dateRange: { start: 2_000, end: 6_000 } })).toHaveLength(1);
  });

  it('matches CJK text by substring, as the observation tier does', () => {
    const { store, search } = open();
    store.upsertToolUse(input({ toolResponse: '{"stdout":"修改了项目配置"}' }));
    const hits = search.searchToolUses('项目');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('[项目]');
  });

  it('caps the hit count and ignores empty queries', () => {
    const { store, search } = open();
    for (let i = 0; i < 30; i += 1) {
      store.upsertToolUse(input({ toolUseId: `toolu_${i}`, toolResponse: `hit ${i}` }));
    }
    expect(search.searchToolUses('hit', { limit: 500 })).toHaveLength(SessionSearch.MAX_TOOL_USE_HITS);
    expect(search.searchToolUses('   ')).toEqual([]);
    expect(search.searchToolUses(undefined)).toEqual([]);
  });

  it('treats FTS syntax in the query as literal text', () => {
    const { store, search } = open();
    store.upsertToolUse(input({ toolResponse: 'value NEAR( x' }));
    expect(() => search.searchToolUses('NEAR( "x')).not.toThrow();
  });
});

describe('ResultFormatter.formatToolUseHits', () => {
  it('renders pointers and a get_tool_uses follow-up, escaping pipes', () => {
    const text = ResultFormatter.formatToolUseHits('needle', [{
      id: 7,
      tool_use_id: 'toolu_7',
      tool_name: 'Bash',
      project: 'p',
      observation_id: 12,
      created_at: '2026-11-25T00:00:00.000Z',
      created_at_epoch: 0,
      snippet: 'a | b\n[needle]',
    }]);
    expect(text).toContain('No memory matches for "needle"');
    expect(text).toContain('| 7 | Bash | 2026-11-25T00:00:00.000Z | #12 | a \\| b [needle] |');
    expect(text).toContain('get_tool_uses(ids=[7])');
  });
});
