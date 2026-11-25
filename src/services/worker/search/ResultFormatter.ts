import type { ToolUseSearchHit } from '../../sqlite/SessionSearch.js';


export class ResultFormatter {
  static formatChromaFailureMessage(reason: { message: string; isConnectionError: boolean }): string {
    if (reason.isConnectionError) {
      return `Semantic search is offline (Chroma MCP unreachable: ${reason.message}). Falling back to keyword search; results may be incomplete. Run \`/api/chroma/status?deep=1\` to diagnose.`;
    }
    return `Semantic search failed: ${reason.message}. Falling back to keyword search; results may be incomplete. Check \`~/.claude-mem/logs/\` for the CHROMA_SYNC entry. Run \`/api/chroma/status?deep=1\` for a deeper probe.`;
  }

  /**
   * Render raw tool I/O hits (#4060) as pointers: id, tool, time and a one-line snippet. The
   * payloads themselves stay behind get_tool_uses, which is where the agent fetches them.
   */
  static formatToolUseHits(query: string, hits: ToolUseSearchHit[]): string {
    const lines = [
      `No memory matches for "${query}". Found ${hits.length} match(es) in raw tool input/output:`,
      '',
      '| ID | Tool | When | Obs | Snippet |',
      '|----|------|------|-----|---------|',
    ];
    for (const hit of hits) {
      const snippet = (hit.snippet || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
      const obs = hit.observation_id != null ? `#${hit.observation_id}` : '-';
      lines.push(`| ${hit.id} | ${hit.tool_name} | ${hit.created_at} | ${obs} | ${snippet} |`);
    }
    lines.push('');
    lines.push(`Fetch full payloads with get_tool_uses(ids=[${hits.map(hit => hit.id).join(', ')}]) — only the ones you need.`);
    return lines.join('\n');
  }
}
