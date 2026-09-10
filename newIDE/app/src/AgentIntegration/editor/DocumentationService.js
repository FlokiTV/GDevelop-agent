// @flow
import { getIDEVersionWithHash } from '../../Version';
import { AgentError } from '../core/AgentError';

export const GDEVELOP_DOCS_ROOT = 'https://wiki.gdevelop.io/gdevelop5/';
export const GDEVELOP_DOCSEARCH_APP_ID = 'RC2XAJAUNE';
export const GDEVELOP_DOCSEARCH_INDEX = 'gdevelop';
// Public search-only key embedded by the official documentation itself.
export const GDEVELOP_DOCSEARCH_API_KEY =
  '99faf69cae196db15d6916f2ed0116b9';

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_READ_CHARS = 50000;

const clampInteger = (value: any, fallback: number, min: number, max: number) => {
  const number = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, number));
};

const throwIfCancelled = (signal: any) => {
  if (signal && signal.aborted) {
    throw new AgentError({
      code: 'operation_cancelled',
      message: 'The documentation operation was cancelled.',
    });
  }
};

const fetchTextBounded = async ({
  fetchImpl,
  url,
  options = {},
  signal,
  timeoutMs,
  maxResponseBytes,
  errorPrefix,
}: any): Promise<{| text: string, response: any |}> => {
  throwIfCancelled(signal);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal && signal.addEventListener) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response || !response.ok) {
      throw new AgentError({
        code: `${errorPrefix}_http_error`,
        message: `Documentation request failed with HTTP ${
          response ? response.status : 'unknown'
        }.`,
        retryable: !!response && response.status >= 500,
        details: { url, status: response ? response.status : null },
      });
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxResponseBytes) {
      controller.abort();
      throw new AgentError({
        code: `${errorPrefix}_payload_too_large`,
        message: `Documentation response exceeds the ${maxResponseBytes}-byte limit.`,
        details: { url, declaredLength, maxResponseBytes },
      });
    }
    const text = await response.text();
    if (text.length > maxResponseBytes) {
      throw new AgentError({
        code: `${errorPrefix}_payload_too_large`,
        message: `Documentation response exceeds the ${maxResponseBytes}-byte limit.`,
        details: { url, actualCharacters: text.length, maxResponseBytes },
      });
    }
    throwIfCancelled(signal);
    return { text, response };
  } catch (error) {
    if (error instanceof AgentError) throw error;
    if (signal && signal.aborted) {
      throw new AgentError({
        code: 'operation_cancelled',
        message: 'The documentation operation was cancelled.',
        cause: error,
      });
    }
    if (timedOut) {
      throw new AgentError({
        code: `${errorPrefix}_timeout`,
        message: `Documentation request timed out after ${timeoutMs}ms.`,
        retryable: true,
        details: { url, timeoutMs },
        cause: error,
      });
    }
    throw new AgentError({
      code: `${errorPrefix}_unavailable`,
      message:
        'GDevelop documentation is unavailable. Check the network connection and try again.',
      retryable: true,
      details: { url },
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    if (signal && signal.removeEventListener) {
      signal.removeEventListener('abort', onAbort);
    }
  }
};

const deepestHierarchyTitle = (hierarchy: any): string => {
  if (!hierarchy || typeof hierarchy !== 'object') return '';
  for (let index = 6; index >= 0; index--) {
    const value = hierarchy[`lvl${index}`];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const normalizeWhitespace = (value: string): string =>
  value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const htmlToDocumentationText = (html: string): string => {
  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const root =
      parsed.querySelector('article.md-content__inner') ||
      parsed.querySelector('.md-content') ||
      parsed.querySelector('main') ||
      parsed.body;
    if (root) {
      root
        .querySelectorAll('script,style,nav,button,form,.md-source-file')
        .forEach(element => element.remove());
      return normalizeWhitespace(root.textContent || '');
    }
  }

  return normalizeWhitespace(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  );
};

const resolveDocsUrl = (value: string): string => {
  let resolved;
  try {
    resolved = new URL(value, GDEVELOP_DOCS_ROOT);
  } catch (error) {
    throw new AgentError({ code: 'invalid_documentation_url' });
  }
  if (
    resolved.protocol !== 'https:' ||
    resolved.hostname !== 'wiki.gdevelop.io' ||
    !resolved.pathname.startsWith('/gdevelop5/')
  ) {
    throw new AgentError({
      code: 'documentation_url_not_allowed',
      message: 'docs.read only accepts URLs under the official GDevelop 5 documentation root.',
      details: { url: resolved.toString() },
    });
  }
  return resolved.toString();
};

export const createDocumentationService = ({
  fetchImpl =
    typeof window !== 'undefined' && window.fetch
      ? window.fetch.bind(window)
      : typeof fetch !== 'undefined'
      ? fetch
      : null,
  now = () => Date.now(),
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}: any = {}) => {
  if (!fetchImpl) {
    throw new Error('documentation_fetch_unavailable');
  }

  const makeSource = () => ({
    provider: 'gdevelop-official-docs',
    baseUrl: GDEVELOP_DOCS_ROOT,
    searchProvider: 'algolia-docsearch',
    searchIndex: GDEVELOP_DOCSEARCH_INDEX,
    ideVersionWithHash: getIDEVersionWithHash(),
    retrievedAt: new Date(now()).toISOString(),
  });

  const search = async (request: any, signal?: any) => {
    const query =
      request && typeof request.query === 'string' ? request.query.trim() : '';
    if (!query) throw new AgentError({ code: 'missing_documentation_query' });
    const limit = clampInteger(request.limit, 8, 1, 20);
    const timeoutMs = clampInteger(
      request.timeoutMs,
      defaultTimeoutMs,
      1000,
      MAX_TIMEOUT_MS
    );
    const endpoint = `https://${GDEVELOP_DOCSEARCH_APP_ID}-dsn.algolia.net/1/indexes/${GDEVELOP_DOCSEARCH_INDEX}/query`;
    const { text } = await fetchTextBounded({
      fetchImpl,
      url: endpoint,
      options: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-algolia-application-id': GDEVELOP_DOCSEARCH_APP_ID,
          'x-algolia-api-key': GDEVELOP_DOCSEARCH_API_KEY,
        },
        body: JSON.stringify({
          query,
          hitsPerPage: limit,
          analytics: false,
          clickAnalytics: false,
          attributesToRetrieve: ['hierarchy', 'content', 'url', 'type'],
        }),
      },
      signal,
      timeoutMs,
      maxResponseBytes,
      errorPrefix: 'documentation_search',
    });

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new AgentError({
        code: 'documentation_search_invalid_response',
        retryable: true,
        cause: error,
      });
    }
    const hits = Array.isArray(payload.hits) ? payload.hits : [];
    return {
      query,
      total: Number.isFinite(payload.nbHits) ? payload.nbHits : hits.length,
      results: hits.slice(0, limit).map(hit => ({
        title: deepestHierarchyTitle(hit.hierarchy) || 'GDevelop documentation',
        url: typeof hit.url === 'string' ? hit.url : null,
        sectionType: typeof hit.type === 'string' ? hit.type : null,
        excerpt:
          typeof hit.content === 'string' && hit.content.trim()
            ? normalizeWhitespace(hit.content).slice(0, 1200)
            : null,
      })),
      source: makeSource(),
      cache: { policy: 'remote-index', ttlMs: 0 },
    };
  };

  const read = async (request: any, signal?: any) => {
    const requestedUrl =
      request && typeof request.url === 'string' ? request.url.trim() : '';
    if (!requestedUrl) throw new AgentError({ code: 'missing_documentation_url' });
    const url = resolveDocsUrl(requestedUrl);
    const timeoutMs = clampInteger(
      request.timeoutMs,
      defaultTimeoutMs,
      1000,
      MAX_TIMEOUT_MS
    );
    const maxChars = clampInteger(request.maxChars, 12000, 1000, MAX_READ_CHARS);
    const { text: html } = await fetchTextBounded({
      fetchImpl,
      url,
      signal,
      timeoutMs,
      maxResponseBytes,
      errorPrefix: 'documentation_read',
    });
    const text = htmlToDocumentationText(html);
    return {
      url,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      totalCharacters: text.length,
      source: makeSource(),
      cache: { policy: 'http-edge-and-process', ttlMs: 300000 },
    };
  };

  return { search, read };
};
