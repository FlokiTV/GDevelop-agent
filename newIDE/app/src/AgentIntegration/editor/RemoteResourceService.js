// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import { AgentError } from '../core/AgentError';
import { inferResourceKind } from '../AssetTools';

const crypto = optionalRequire('crypto');
const dns = optionalRequire('dns');
const fs = optionalRequire('fs');
const http = optionalRequire('http');
const https = optionalRequire('https');
const net = optionalRequire('net');
const os = optionalRequire('os');
const path = optionalRequire('path');

export const DEFAULT_MAX_REMOTE_RESOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_RESOURCE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_REMOTE_RESOURCE_TIMEOUT_MS = 30000;
export const MAX_REMOTE_RESOURCE_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const RESOURCE_PROVENANCE_ORIGIN = 'remote-url';

const MIME_TO_EXTENSION = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/json': '.json',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-sfnt': '.ttf',
  'model/gltf-binary': '.glb',
};

const MIME_TO_KIND = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
  'application/json': 'json',
  'font/ttf': 'font',
  'font/otf': 'font',
  'application/font-sfnt': 'font',
  'model/gltf-binary': 'model3D',
};

const normalizeMime = (value: any): string =>
  typeof value === 'string'
    ? value
        .split(';')[0]
        .trim()
        .toLowerCase()
    : '';

const normalizeLimit = (value: any, fallback: number, max: number): number => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(1, Math.round(number)))
    : fallback;
};

const parseIpv4 = (address: string): ?Array<number> => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map(part => Number(part));
  return bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null;
};

const isBlockedIpv4 = (address: string): boolean => {
  const bytes = parseIpv4(address);
  if (!bytes) return true;
  const [a, b, c] = bytes;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
};

const ipv4FromMappedIpv6 = (address: string): ?string => {
  const lower = address.toLowerCase().split('%')[0];
  const marker = '::ffff:';
  if (!lower.startsWith(marker)) return null;
  const suffix = lower.slice(marker.length);
  if (suffix.includes('.')) return suffix;
  const words = suffix.split(':');
  if (words.length !== 2) return null;
  const first = parseInt(words[0], 16);
  const second = parseInt(words[1], 16);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return [first >> 8, first & 255, second >> 8, second & 255].join('.');
};

const isBlockedIpv6 = (address: string): boolean => {
  const lower = address.toLowerCase().split('%')[0];
  const mapped = ipv4FromMappedIpv6(lower);
  if (mapped) return isBlockedIpv4(mapped);
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('ff')) return true;
  if (lower.startsWith('2001:db8:')) return true;
  if (lower.startsWith('2001:2:')) return true;
  if (lower.startsWith('2001:10:')) return true;
  return false;
};

export const isBlockedRemoteAddress = (address: string): boolean => {
  const family = net && typeof net.isIP === 'function' ? net.isIP(address) : 0;
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
};

const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized) return true;
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized === 'localhost.localdomain'
  ) {
    return true;
  }
  const ipFamily =
    net && typeof net.isIP === 'function' ? net.isIP(normalized) : 0;
  // Single-label DNS names are commonly intranet/service-discovery hosts.
  if (!ipFamily && !normalized.includes('.')) return true;
  return ipFamily ? isBlockedRemoteAddress(normalized) : false;
};

export const parseAndValidateRemoteUrl = (value: any): URL => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({ code: 'missing_remote_resource_url' });
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (cause) {
    throw new AgentError({ code: 'invalid_remote_resource_url', cause });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AgentError({
      code: 'remote_resource_protocol_not_allowed',
      details: { protocol: parsed.protocol },
    });
  }
  if (parsed.username || parsed.password) {
    throw new AgentError({ code: 'remote_resource_credentials_not_allowed' });
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new AgentError({
      code: 'remote_resource_host_not_allowed',
      details: { hostname: parsed.hostname },
    });
  }
  return parsed;
};

export const sanitizeProvenanceUrl = (value: string): string => {
  const parsed = parseAndValidateRemoteUrl(value);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
};

const lookupPublicAddresses = async (hostname: string): Promise<Array<any>> => {
  if (!dns || !dns.promises || typeof dns.promises.lookup !== 'function') {
    throw new AgentError({
      code: 'remote_resource_dns_unavailable',
      recovery:
        'Remote URL ingestion requires the Electron/Node desktop runtime.',
    });
  }
  const directFamily =
    net && typeof net.isIP === 'function' ? net.isIP(hostname) : 0;
  const addresses = directFamily
    ? [{ address: hostname, family: directFamily }]
    : await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) {
    throw new AgentError({
      code: 'remote_resource_dns_empty',
      details: { hostname },
    });
  }
  const blocked = addresses.filter(item =>
    isBlockedRemoteAddress(item.address)
  );
  if (blocked.length) {
    throw new AgentError({
      code: 'remote_resource_private_address_blocked',
      details: {
        hostname,
        blockedFamilies: blocked.map(item => item.family),
      },
    });
  }
  return addresses;
};

const sniffContentType = (buffer: any): ?string => {
  if (!buffer || buffer.length < 4) return null;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.slice(1, 4).toString('ascii') === 'PNG'
  )
    return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WAVE'
  )
    return 'audio/wav';
  if (buffer.slice(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buffer.slice(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'glTF')
    return 'model/gltf-binary';
  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp')
    return 'video/mp4';
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  )
    return 'video/webm';
  if (buffer.slice(0, 4).toString('ascii') === 'OTTO') return 'font/otf';
  if (
    buffer[0] === 0x00 &&
    buffer[1] === 0x01 &&
    buffer[2] === 0x00 &&
    buffer[3] === 0x00
  )
    return 'font/ttf';
  const sample = buffer
    .slice(0, Math.min(buffer.length, 512))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (sample.startsWith('{') || sample.startsWith('['))
    return 'application/json';
  return null;
};

const makePinnedLookup = (addresses: Array<any>) => (
  _hostname,
  options,
  callback
) => {
  const normalizedOptions =
    typeof options === 'number' ? { family: options } : options || {};
  const requestedFamily = normalizedOptions.family
    ? Number(normalizedOptions.family)
    : 0;
  const candidates = requestedFamily
    ? addresses.filter(item => item.family === requestedFamily)
    : addresses;
  if (!candidates.length) {
    const error: any = new Error('remote_resource_dns_family_unavailable');
    error.code = 'EAI_ADDRFAMILY';
    callback(error);
    return;
  }
  if (normalizedOptions.all === true) {
    callback(
      null,
      candidates.map(item => ({
        address: item.address,
        family: item.family,
      }))
    );
    return;
  }
  callback(null, candidates[0].address, candidates[0].family);
};

const downloadOne = async ({
  parsedUrl,
  maxBytes,
  timeoutMs,
}: {|
  parsedUrl: URL,
  maxBytes: number,
  timeoutMs: number,
|}): Promise<any> => {
  if (!http || !https || !crypto) {
    throw new AgentError({
      code: 'remote_resource_runtime_unavailable',
      recovery:
        'Remote URL ingestion requires the Electron/Node desktop runtime.',
    });
  }
  const addresses = await lookupPublicAddresses(parsedUrl.hostname);
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport.request(
      parsedUrl,
      {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'User-Agent': 'GDevelop-AgentIntegration/1.0',
        },
        agent: false,
        lookup: makePinnedLookup(addresses),
      },
      response => {
        const statusCode = Number(response.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          response.resume();
          settled = true;
          return resolve({
            redirect: response.headers.location || null,
            statusCode,
          });
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          return fail(
            new AgentError({
              code: 'remote_resource_http_error',
              details: { statusCode },
            })
          );
        }
        const contentLength = Number(response.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.destroy();
          return fail(
            new AgentError({
              code: 'remote_resource_too_large',
              details: { contentLength, maxBytes },
            })
          );
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            response.destroy();
            fail(
              new AgentError({
                code: 'remote_resource_too_large',
                details: { receivedBytes: bytes, maxBytes },
              })
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          if (settled) return;
          settled = true;
          const buffer = Buffer.concat(chunks);
          const declaredMime = normalizeMime(response.headers['content-type']);
          const sniffedMime = sniffContentType(buffer);
          resolve({
            buffer,
            statusCode,
            declaredMime,
            sniffedMime,
            contentDisposition: response.headers['content-disposition'] || null,
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fail(
        new AgentError({
          code: 'remote_resource_timeout',
          retryable: true,
          details: { timeoutMs },
        })
      );
    });
    request.on('error', fail);
    request.end();
  });
};

export const downloadRemoteResource = async ({
  url,
  maxBytes = DEFAULT_MAX_REMOTE_RESOURCE_BYTES,
  timeoutMs = DEFAULT_REMOTE_RESOURCE_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  expectedSha256,
}: any): Promise<any> => {
  const normalizedMaxBytes = normalizeLimit(
    maxBytes,
    DEFAULT_MAX_REMOTE_RESOURCE_BYTES,
    MAX_REMOTE_RESOURCE_BYTES
  );
  const normalizedTimeout = normalizeLimit(
    timeoutMs,
    DEFAULT_REMOTE_RESOURCE_TIMEOUT_MS,
    MAX_REMOTE_RESOURCE_TIMEOUT_MS
  );
  const redirectLimit = Math.min(10, Math.max(0, Number(maxRedirects) || 0));
  const original = parseAndValidateRemoteUrl(url);
  let current = original;
  let redirects = 0;
  while (true) {
    const result = await downloadOne({
      parsedUrl: current,
      maxBytes: normalizedMaxBytes,
      timeoutMs: normalizedTimeout,
    });
    if (
      [301, 302, 303, 307, 308].includes(result.statusCode) &&
      !result.redirect
    ) {
      throw new AgentError({
        code: 'remote_resource_redirect_missing_location',
      });
    }
    if (!result.redirect) {
      const hash = crypto
        .createHash('sha256')
        .update(result.buffer)
        .digest('hex');
      if (
        typeof expectedSha256 === 'string' &&
        expectedSha256 &&
        expectedSha256.toLowerCase() !== hash
      ) {
        throw new AgentError({
          code: 'remote_resource_checksum_mismatch',
          details: {
            expectedSha256: expectedSha256.toLowerCase(),
            sha256: hash,
          },
        });
      }
      const declaredMime = result.declaredMime;
      const sniffedMime = result.sniffedMime;
      if (
        declaredMime &&
        sniffedMime &&
        declaredMime !== 'application/octet-stream' &&
        declaredMime !== sniffedMime &&
        declaredMime.split('/')[0] !== sniffedMime.split('/')[0]
      ) {
        throw new AgentError({
          code: 'remote_resource_mime_mismatch',
          details: { declaredMime, sniffedMime },
        });
      }
      return {
        buffer: result.buffer,
        byteLength: result.buffer.length,
        sha256: hash,
        contentType: sniffedMime || declaredMime || 'application/octet-stream',
        originalUrl: original.toString(),
        finalUrl: current.toString(),
        redirectCount: redirects,
      };
    }
    if (!result.redirect || redirects >= redirectLimit) {
      throw new AgentError({
        code: 'remote_resource_redirect_limit',
        details: { maxRedirects: redirectLimit },
      });
    }
    redirects++;
    current = parseAndValidateRemoteUrl(
      new URL(result.redirect, current.toString()).toString()
    );
  }
};

const sanitizeFileNameCharacters = (value: string): string => {
  let sanitized = '';
  let replacingUnsafeSequence = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const unsafe = code <= 0x1f || '\\\\/:*?"<>|'.includes(character);
    if (unsafe) {
      if (!replacingUnsafeSequence) sanitized += '-';
      replacingUnsafeSequence = true;
    } else {
      sanitized += character;
      replacingUnsafeSequence = false;
    }
  }
  return sanitized;
};

const deriveFileName = ({ finalUrl, contentType }: any): string => {
  let basename = '';
  try {
    const parsed = new URL(finalUrl);
    basename = decodeURIComponent(parsed.pathname.split('/').pop() || '');
  } catch (error) {}
  basename = sanitizeFileNameCharacters(basename)
    .replace(/^\.+/, '')
    .slice(0, 180);
  const extension = path && basename ? path.extname(basename) : '';
  if (!extension && MIME_TO_EXTENSION[contentType]) {
    basename = `${basename || 'remote-resource'}${
      MIME_TO_EXTENSION[contentType]
    }`;
  }
  return basename || 'remote-resource.bin';
};

const assertContentKindCompatible = ({ requestedKind, contentType }: any) => {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    throw new AgentError({
      code: 'remote_resource_unsafe_content_type',
      details: { contentType },
    });
  }
  if (typeof requestedKind !== 'string' || !requestedKind) return;
  const detectedKind = MIME_TO_KIND[contentType];
  if (!detectedKind) return;
  const jsonCompatibleKinds = ['json', 'tilemap', 'tileset', 'spine'];
  if (
    detectedKind !== requestedKind &&
    !(detectedKind === 'json' && jsonCompatibleKinds.includes(requestedKind))
  ) {
    throw new AgentError({
      code: 'remote_resource_kind_mismatch',
      details: { requestedKind, detectedKind, contentType },
    });
  }
};

const inferKind = ({ requestedKind, fileName, contentType }: any): ?string => {
  assertContentKindCompatible({ requestedKind, contentType });
  if (typeof requestedKind === 'string' && requestedKind) return requestedKind;
  return MIME_TO_KIND[contentType] || inferResourceKind(fileName);
};

const makeProvenance = ({ download, input }: any) => ({
  schema: 'gdevelop-agent-resource-provenance/v1',
  source: 'remote-url',
  sourceUrl: sanitizeProvenanceUrl(download.originalUrl),
  finalUrl: sanitizeProvenanceUrl(download.finalUrl),
  sourceUrlQueryRedacted: new URL(download.originalUrl).search.length > 0,
  finalUrlQueryRedacted: new URL(download.finalUrl).search.length > 0,
  sha256: download.sha256,
  byteLength: download.byteLength,
  contentType: download.contentType,
  redirectCount: download.redirectCount,
  ...(typeof input.license === 'string' && input.license
    ? { license: input.license.slice(0, 500) }
    : {}),
  ...(typeof input.author === 'string' && input.author
    ? { author: input.author.slice(0, 500) }
    : {}),
  ...(typeof input.attribution === 'string' && input.attribution
    ? { attribution: input.attribution.slice(0, 2000) }
    : {}),
});

const writeTemporaryDownload = (download: any): any => {
  if (!fs || !os || !path) {
    throw new AgentError({ code: 'remote_resource_filesystem_unavailable' });
  }
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-agent-remote-')
  );
  const fileName = deriveFileName(download);
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, download.buffer);
  return { directory, filePath, fileName };
};

const removeTemporaryDownload = (temporary: any) => {
  if (!fs || !temporary || !temporary.directory) return;
  try {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  } catch (error) {}
};

type Options = {|
  project: gdProject,
  assetTools: any,
  downloader?: (input: any) => Promise<any>,
|};

export const createRemoteResourceService = ({
  project,
  assetTools,
  downloader = downloadRemoteResource,
}: Options) => {
  const requireSavedProject = () => {
    if (!project || !project.getProjectFile()) {
      throw new AgentError({
        code: 'remote_resource_requires_saved_project',
        hint:
          'Save the project to a local file first so downloaded bytes can be copied into the project folder deterministically.',
      });
    }
  };

  const downloadAndPrepare = async (input: any) => {
    requireSavedProject();
    const download = await downloader({
      url: input.url,
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      maxRedirects: input.maxRedirects,
      expectedSha256: input.expectedSha256,
    });
    const fileName = deriveFileName(download);
    const kind = inferKind({
      requestedKind: input.kind,
      fileName,
      contentType: download.contentType,
    });
    if (!kind) {
      throw new AgentError({
        code: 'unable_to_infer_resource_kind',
        details: { contentType: download.contentType },
      });
    }
    const temporary = writeTemporaryDownload(download);
    return {
      download,
      temporary,
      kind,
      provenance: makeProvenance({ download, input }),
    };
  };

  const importUrl = async (input: any) => {
    let prepared = null;
    try {
      prepared = await downloadAndPrepare(input);
      const resourceName =
        (typeof input.resourceName === 'string' && input.resourceName.trim()) ||
        prepared.temporary.fileName;
      const result = await assetTools.importLocalResource({
        filePath: prepared.temporary.filePath,
        resourceName,
        kind: prepared.kind,
        copyToProject: true,
        overwrite: !!input.overwrite,
        origin: {
          name: RESOURCE_PROVENANCE_ORIGIN,
          identifier: prepared.provenance.sourceUrl,
        },
        provenance: prepared.provenance,
      });
      return {
        ...result,
        download: {
          sha256: prepared.download.sha256,
          byteLength: prepared.download.byteLength,
          contentType: prepared.download.contentType,
          redirectCount: prepared.download.redirectCount,
        },
        provenance: prepared.provenance,
      };
    } finally {
      if (prepared) removeTemporaryDownload(prepared.temporary);
    }
  };

  const replaceUrl = async (input: any) => {
    let prepared = null;
    try {
      prepared = await downloadAndPrepare(input);
      const result = await assetTools.replaceLocalResource({
        resourceName: input.resourceName,
        filePath: prepared.temporary.filePath,
        kind: prepared.kind,
        copyToProject: true,
        deletePreviousFile: !!input.deletePreviousFile,
        origin: {
          name: RESOURCE_PROVENANCE_ORIGIN,
          identifier: prepared.provenance.sourceUrl,
        },
        provenance: prepared.provenance,
      });
      return {
        ...result,
        download: {
          sha256: prepared.download.sha256,
          byteLength: prepared.download.byteLength,
          contentType: prepared.download.contentType,
          redirectCount: prepared.download.redirectCount,
        },
        provenance: prepared.provenance,
      };
    } finally {
      if (prepared) removeTemporaryDownload(prepared.temporary);
    }
  };

  return { importUrl, replaceUrl };
};

export const remoteResourceInternals = {
  deriveFileName,
  inferKind,
  isBlockedHostname,
  isBlockedIpv4,
  isBlockedIpv6,
  lookupPublicAddresses,
  makePinnedLookup,
  makeProvenance,
  sniffContentType,
};
