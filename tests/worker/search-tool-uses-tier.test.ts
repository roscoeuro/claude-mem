import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #4060 — search falls through to raw tool I/O only when observation-level search is empty.
// Runs in a child process so the settings/data dir the worker modules resolve stay isolated.
const fixture = `
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  const store = new SessionStore(':memory:');
  try {
    const sid = store.createSDKSession('host-tier', 'tier', 'prompt');
    store.updateMemorySessionId(sid, 'memory-tier');
    store.storeObservation('memory-tier', 'tier', {
      type: 'discovery', title: 'Observed wombat', subtitle: null, facts: [], narrative: 'wombat narrative',
      concepts: [], files_read: [], files_modified: [],
    }, 1, 0, Date.now());
    store.upsertToolUse({ toolUseId: 'toolu_a', contentSessionId: 'host-tier', project: 'tier', toolName: 'Bash',
      toolInput: '{"command":"curl localhost"}', toolResponse: '{"stderr":"ECONNREFUSED wombat"}' });
    const manager = new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
    const out = {
      observationHit: await manager.search({ query: 'wombat', project: 'tier', format: 'json' }),
      deepJson: await manager.search({ query: 'ECONNREFUSED', project: 'tier', format: 'json' }),
      deepText: await manager.search({ query: 'ECONNREFUSED', project: 'tier' }),
      otherProject: await manager.search({ query: 'ECONNREFUSED', project: 'elsewhere', format: 'json' }),
      sessionsOnly: await manager.search({ query: 'ECONNREFUSED', project: 'tier', type: 'sessions', format: 'json' }),
      nothing: await manager.search({ query: 'zzznotthere', project: 'tier' }),
    };
    console.log(JSON.stringify(out));
  } finally { store.close(); }
`;

describe('search raw tool I/O tier (#4060)', () => {
  it('surfaces tool I/O hits only when memory search is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-tool-tier-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const out = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);

      // Observation matches exist: the deeper tier is not consulted.
      expect(out.observationHit.totalResults).toBeGreaterThan(0);
      expect(out.observationHit.toolUses).toBeUndefined();

      // No memory match: tool I/O hits come back as pointers, not results.
      expect(out.deepJson.totalResults).toBe(0);
      expect(out.deepJson.toolUses).toHaveLength(1);
      expect(out.deepJson.toolUses[0].tool_name).toBe('Bash');
      const text = out.deepText.content[0].text as string;
      expect(text).toContain('raw tool input/output');
      expect(text).toContain(`get_tool_uses(ids=[${out.deepJson.toolUses[0].id}])`);

      // Project scope and category selection still apply.
      expect(out.otherProject.toolUses).toBeUndefined();
      expect(out.sessionsOnly.toolUses).toBeUndefined();

      expect(out.nothing.content[0].text).toBe('No results found matching "zzznotthere"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
