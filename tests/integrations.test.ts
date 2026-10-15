import { describe, expect, it } from 'vitest';
import { buildRegistryConfig, extractSecrets, fromRegistry, registryServerName } from '../src/core/integrations';
import { parseSlash } from '../src/core/slash';
import { parsePastedConfig } from '../src/core/mcp/import';
import { buildCatalogConfig, catalogEntry } from '../src/core/mcp/catalog';

describe('integrations', () => {
  it('moves literal secrets out of configs', () => {
    const { config, secrets } = extractSecrets({ command: 'npx', args: ['x'], env: { GITHUB_TOKEN: 'ghp_123', LOG_LEVEL: 'info' }, headers: { Authorization: 'Bearer abc' } });
    expect(config.env).toEqual({ GITHUB_TOKEN: '${secret:GITHUB_TOKEN}', LOG_LEVEL: 'info' });
    expect(config.headers?.Authorization).toBe('Bearer ${secret:AUTHORIZATION}');
    expect(secrets).toEqual({ GITHUB_TOKEN: 'ghp_123', AUTHORIZATION: 'abc' });
  });

  it('turns an MCP Registry entry (REA server.json) into a runnable config', () => {
    const rea = {
      name: 'io.github.morluto/rea',
      title: 'REA',
      description: 'Reverse engineer anything from your terminal or agent with one CLI and MCP server.',
      version: '6.5.0',
      packages: [{ registryType: 'npm', identifier: 'rea-agents', version: '6.5.0', runtimeHint: 'npx', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', value: 'mcp' }] }],
    };
    const s = fromRegistry(rea);
    expect(s.kind).toBe('npm');
    expect(s.install).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.5.0', 'mcp'] });
    expect(registryServerName(s.name)).toBe('rea');
    expect(buildRegistryConfig(s, {}).config.command).toBe('npx');
  });

  it('handles remote registry entries with auth headers', () => {
    const s = fromRegistry({ name: 'com.example/tickets', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', isSecret: true, isRequired: true }] }] });
    expect(s.install).toMatchObject({ type: 'http', url: 'https://mcp.example.com/mcp' });
    const { config, secrets } = buildRegistryConfig(s, { AUTHORIZATION: 'tok' });
    expect(config.headers?.Authorization).toBe('Bearer ${secret:AUTHORIZATION}');
    expect(secrets.AUTHORIZATION).toBe('tok');
  });

  it('parses pasted configs in several dialects', () => {
    const a = parsePastedConfig('{"mcpServers":{"rea":{"command":"npx","args":["-y","rea-agents","mcp"]}}}');
    expect(a.rea?.command).toBe('npx');
    const b = parsePastedConfig('{"servers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}');
    expect(b.linear?.url).toBe('https://mcp.linear.app/mcp');
  });

  it('builds catalog configs with secret references', () => {
    const rea = catalogEntry('rea');
    expect(rea).toBeTruthy();
    const { config } = buildCatalogConfig(rea!, {});
    expect(config.args?.join(' ')).toContain('rea-agents');
  });

  it('parses slash commands', () => {
    expect(parseSlash('/review main')).toEqual({ name: 'review', args: 'main' });
    expect(parseSlash('/mcp__github__create_issue title="x"')?.name).toBe('mcp__github__create_issue');
    expect(parseSlash('not a command')).toBeNull();
  });
});
