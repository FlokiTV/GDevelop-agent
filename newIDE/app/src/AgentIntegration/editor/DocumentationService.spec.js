// @flow
import { createDocumentationService } from './DocumentationService';

const makeResponse = ({
  status = 200,
  body = '',
  headers = {},
}: any = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] || null },
  text: async () => body,
});

describe('DocumentationService', () => {
  it('searches the official DocSearch index and returns bounded canonical results', async () => {
    const fetchImpl = jest.fn(async () =>
      makeResponse({
        body: JSON.stringify({
          nbHits: 2,
          hits: [
            {
              url: 'https://wiki.gdevelop.io/gdevelop5/behaviors/platformer/#jump',
              type: 'lvl2',
              hierarchy: {
                lvl0: 'Platformer',
                lvl1: 'Character',
                lvl2: 'Jumping',
              },
              content: 'Configure the jump speed.',
            },
          ],
        }),
      })
    );
    const service = createDocumentationService({ fetchImpl, now: () => 0 });

    const result = await service.search({ query: 'platformer', limit: 1 });

    expect(result.total).toBe(2);
    expect(result.results).toEqual([
      expect.objectContaining({
        title: 'Jumping',
        url: 'https://wiki.gdevelop.io/gdevelop5/behaviors/platformer/#jump',
        excerpt: 'Configure the jump speed.',
      }),
    ]);
    expect(result.source.provider).toBe('gdevelop-official-docs');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('algolia.net/1/indexes/gdevelop/query'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('reads and truncates only pages under the official GDevelop 5 docs root', async () => {
    const fetchImpl = jest.fn(async () =>
      makeResponse({
        body: '<html><main><h1>Platformer</h1><p>Jump and run.</p></main></html>',
      })
    );
    const service = createDocumentationService({ fetchImpl });

    const result = await service.read({
      url: '/gdevelop5/behaviors/platformer/',
      maxChars: 1000,
    });

    expect(result.text).toContain('Platformer');
    expect(result.text).toContain('Jump and run.');
    expect(result.truncated).toBe(false);
    await expect(
      service.read({ url: 'https://example.com/not-allowed' })
    ).rejects.toMatchObject({ code: 'documentation_url_not_allowed' });
  });

  it('rejects oversized declared responses', async () => {
    const service = createDocumentationService({
      maxResponseBytes: 10,
      fetchImpl: async () =>
        makeResponse({ body: 'small', headers: { 'content-length': '11' } }),
    });

    await expect(service.search({ query: 'x' })).rejects.toMatchObject({
      code: 'documentation_search_payload_too_large',
    });
  });

  it('propagates cancellation and timeout as explicit AgentErrors', async () => {
    const fetchImpl = (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const service = createDocumentationService({
      fetchImpl,
      defaultTimeoutMs: 10,
    });

    await expect(
      service.search({ query: 'x', timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'documentation_search_timeout' });

    const controller = new AbortController();
    const pending = service.search({ query: 'x', timeoutMs: 30000 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'operation_cancelled' });
  });
});
