import { expect, it } from 'vitest';
import { buildWorkspaceClientLink, isWorkspaceDirectory, normalizeWorkspaceEndpoint, parseWorkspaceClientLink } from '../../../../packages/web/plugins/agent-tools/src/assets/workspace-link.js';

it.each(['/workspace', '/workspace/main', '/workspace/space and 日本語', '/workspace/percent% and #?'])('round-trips the exact guest directory %s without credentials', (directory) => {
  const endpoint = 'https://shared.example.test:8443/services/opencode';
  const link = buildWorkspaceClientLink({ endpoint, directory });
  expect(link).toBeDefined();
  if (!link) throw new Error('workspace link missing');
  const url = new URL(link);
  expect(url.origin).toBe('https://slop-lab.github.io');
  expect(url.search).toBe('');
  expect(parseWorkspaceClientLink(url.hash)).toEqual({ endpoint, directory });
});

it.each(['https://EXAMPLE.test:443/', 'http://localhost:4096/', 'http://127.0.0.1:4096', 'http://[::1]:4096'])('normalizes usable endpoint %s', (endpoint) => {
  expect(normalizeWorkspaceEndpoint(endpoint)).toBe(new URL(endpoint).href.replace(/\/+$/, ''));
});

it.each(['javascript:alert(1)', 'data:text/html,x', '//example.test', 'http://worker-relay.test:4096', 'https://user:password@example.test', 'https://example.test?token=secret', 'https://example.test/#password', 'https://example.test/../admin', 'https://example.test/%2e%2e/admin', 'https://example.test/\n', 'https://example.test/\\other'])('rejects unsafe endpoint without constructing a link: %s', (endpoint) => {
  expect(normalizeWorkspaceEndpoint(endpoint)).toBeUndefined();
  expect(buildWorkspaceClientLink({ endpoint, directory: '/workspace/main' })).toBeUndefined();
});

it.each(['/etc/passwd', '/workspace/../private', '/workspace/./main', '/workspace//main', '/workspace/main/', '/workspace/a\\b', '/workspace/a\0b', '/workspace-other'])('rejects noncanonical or foreign directory %s', (directory) => {
  expect(isWorkspaceDirectory(directory)).toBe(false);
  expect(buildWorkspaceClientLink({ endpoint: 'https://example.test', directory })).toBeUndefined();
});

it.each(['#/dim/open', '#/dim/open?server=https%3A%2F%2Fa.test&server=https%3A%2F%2Fb.test&directory=%2Fworkspace', '#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fworkspace&password=secret', '#/dim/open?server=javascript%3Aalert(1)&directory=%2Fworkspace', '#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fetc', '#/other?server=https%3A%2F%2Fa.test&directory=%2Fworkspace'])('rejects malformed launch input without registration: %s', (hash) => {
  expect(parseWorkspaceClientLink(hash)).toBeUndefined();
});
