// @flow
import dns from 'dns';
import { EventEmitter } from 'events';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import {
  createRemoteResourceService,
  downloadRemoteResource,
  isBlockedRemoteAddress,
  parseAndValidateRemoteUrl,
  sanitizeProvenanceUrl,
  remoteResourceInternals,
} from './RemoteResourceService';

const makeDownload = (url: string = 'https://cdn.example.com/player.png') => ({
  buffer: Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    1,
    2,
    3,
  ]),
  byteLength: 11,
  sha256: 'a'.repeat(64),
  contentType: 'image/png',
  originalUrl: `${url}?token=secret#ignored`,
  finalUrl: `${url}?signed=secret`,
  redirectCount: 1,
});

const PNG_BYTES = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  1,
  2,
  3,
]);

const mockPublicDns = () =>
  jest
    .spyOn(dns.promises, 'lookup')
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

const mockHttpsResponses = (responses: Array<any>) =>
  jest
    .spyOn(https, 'request')
    .mockImplementation((_url, _options, callback) => {
      const request: any = new EventEmitter();
      let onTimeout = null;
      request.setTimeout = jest.fn((_timeoutMs, handler) => {
        onTimeout = handler;
      });
      request.destroy = jest.fn();
      request.end = jest.fn(() => {
        const responseDefinition = responses.shift();
        if (!responseDefinition) {
          throw new Error('Missing mocked HTTPS response.');
        }
        if (responseDefinition.timeout) {
          process.nextTick(() => onTimeout && onTimeout());
          return;
        }
        const response: any = new EventEmitter();
        response.statusCode = responseDefinition.statusCode || 200;
        response.headers = responseDefinition.headers || {};
        response.resume = jest.fn();
        response.destroy = jest.fn();
        callback(response);
        process.nextTick(() => {
          (responseDefinition.chunks || []).forEach(chunk =>
            response.emit('data', Buffer.from(chunk))
          );
          if (!response.destroy.mock.calls.length) response.emit('end');
        });
      });
      return request;
    });

describe('AgentIntegration RemoteResourceService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('blocks local/private/reserved targets and accepts public HTTP(S) hosts', () => {
    [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.1.2',
      '192.168.1.5',
      '169.254.1.1',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ].forEach(address => expect(isBlockedRemoteAddress(address)).toBe(true));
    expect(isBlockedRemoteAddress('8.8.8.8')).toBe(false);
    expect(isBlockedRemoteAddress('2606:4700:4700::1111')).toBe(false);

    expect(() => parseAndValidateRemoteUrl('http://localhost/a.png')).toThrow(
      'remote_resource_host_not_allowed'
    );
    expect(() => parseAndValidateRemoteUrl('http://service/a.png')).toThrow(
      'remote_resource_host_not_allowed'
    );
    expect(() => parseAndValidateRemoteUrl('ftp://example.com/a.png')).toThrow(
      'remote_resource_protocol_not_allowed'
    );
    expect(() =>
      parseAndValidateRemoteUrl('https://user:pass@example.com/a.png')
    ).toThrow('remote_resource_credentials_not_allowed');
    expect(
      parseAndValidateRemoteUrl('https://example.com/a.png').hostname
    ).toBe('example.com');
  });

  it('redacts query/fragment from persisted provenance and sniffs common content types', () => {
    expect(
      sanitizeProvenanceUrl(
        'https://cdn.example.com/a.png?token=do-not-persist#fragment'
      )
    ).toBe('https://cdn.example.com/a.png');
    expect(
      remoteResourceInternals.sniffContentType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
      )
    ).toBe('image/png');
    expect(
      remoteResourceInternals.sniffContentType(Buffer.from('{"ok":true}'))
    ).toBe('application/json');
    expect(
      remoteResourceInternals.deriveFileName({
        finalUrl: 'https://cdn.example.com/%00bad%3Aname.png',
        contentType: 'image/png',
      })
    ).toBe('-bad-name.png');
  });

  it('implements the Node lookup callback contract for single and all-address modes', () => {
    const lookup = remoteResourceInternals.makePinnedLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);

    const singleCallback = jest.fn();
    lookup('assets.example.com', { family: 4 }, singleCallback);
    expect(singleCallback).toHaveBeenCalledWith(null, '93.184.216.34', 4);

    const allCallback = jest.fn();
    lookup('assets.example.com', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);

    const unavailableFamilyCallback = jest.fn();
    lookup('assets.example.com', { family: 7 }, unavailableFamilyCallback);
    expect(unavailableFamilyCallback.mock.calls[0][0]).toMatchObject({
      code: 'EAI_ADDRFAMILY',
    });
  });

  it('follows bounded redirects while pinning public DNS and returns deterministic metadata', async () => {
    mockPublicDns();
    const requestSpy = mockHttpsResponses([
      {
        statusCode: 302,
        headers: { location: '/final.png' },
      },
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [PNG_BYTES],
      },
    ]);

    const result = await downloadRemoteResource({
      url: 'https://assets.example.com/start.png',
      maxRedirects: 2,
    });

    expect(result.redirectCount).toBe(1);
    expect(result.finalUrl).toBe('https://assets.example.com/final.png');
    expect(result.contentType).toBe('image/png');
    expect(result.byteLength).toBe(PNG_BYTES.length);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dns.promises.lookup).toHaveBeenCalledTimes(2);
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls[0][1].lookup).toEqual(expect.any(Function));
  });

  it('rejects streamed downloads that exceed maxBytes', async () => {
    mockPublicDns();
    mockHttpsResponses([
      {
        statusCode: 200,
        headers: { 'content-type': 'application/octet-stream' },
        chunks: [Buffer.from('12345')],
      },
    ]);

    await expect(
      downloadRemoteResource({
        url: 'https://assets.example.com/large.bin',
        maxBytes: 4,
      })
    ).rejects.toMatchObject({ code: 'remote_resource_too_large' });
  });

  it('enforces request timeout and checksum validation', async () => {
    mockPublicDns();
    mockHttpsResponses([{ timeout: true }]);
    await expect(
      downloadRemoteResource({
        url: 'https://assets.example.com/slow.png',
        timeoutMs: 1,
      })
    ).rejects.toMatchObject({
      code: 'remote_resource_timeout',
      retryable: true,
    });

    jest.restoreAllMocks();
    mockPublicDns();
    mockHttpsResponses([
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [PNG_BYTES],
      },
    ]);
    await expect(
      downloadRemoteResource({
        url: 'https://assets.example.com/player.png',
        expectedSha256: '0'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'remote_resource_checksum_mismatch' });
  });

  it('rejects declared/sniffed MIME disagreement and DNS resolutions to private addresses', async () => {
    mockPublicDns();
    mockHttpsResponses([
      {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        chunks: [PNG_BYTES],
      },
    ]);
    await expect(
      downloadRemoteResource({
        url: 'https://assets.example.com/disguised.json',
      })
    ).rejects.toMatchObject({ code: 'remote_resource_mime_mismatch' });

    jest.restoreAllMocks();
    jest
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);
    const requestSpy = jest.spyOn(https, 'request');
    await expect(
      downloadRemoteResource({
        url: 'https://assets.example.com/private.png',
      })
    ).rejects.toMatchObject({
      code: 'remote_resource_private_address_blocked',
    });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('downloads to a bounded temporary file then delegates import to AssetTools with provenance', async () => {
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-remote-service-')
    );
    const project = {
      getProjectFile: () => path.join(projectFolder, 'game.json'),
    };
    let temporaryPath = null;
    const importLocalResource = jest.fn(async request => {
      temporaryPath = request.filePath;
      expect(fs.existsSync(request.filePath)).toBe(true);
      expect(request.copyToProject).toBe(true);
      expect(request.kind).toBe('image');
      expect(request.origin).toEqual({
        name: 'remote-url',
        identifier: 'https://cdn.example.com/player.png',
      });
      expect(request.provenance).toMatchObject({
        source: 'remote-url',
        sourceUrl: 'https://cdn.example.com/player.png',
        finalUrl: 'https://cdn.example.com/player.png',
        sourceUrlQueryRedacted: true,
        finalUrlQueryRedacted: true,
        sha256: 'a'.repeat(64),
        byteLength: 11,
        contentType: 'image/png',
      });
      return {
        imported: true,
        provenancePersisted: true,
        resource: { name: request.resourceName, kind: request.kind },
      };
    });
    const service = createRemoteResourceService({
      // $FlowFixMe[incompatible-type]
      project,
      assetTools: { importLocalResource, replaceLocalResource: jest.fn() },
      downloader: jest.fn(async () => makeDownload()),
    });

    const result = await service.importUrl({
      url: 'https://cdn.example.com/player.png?token=secret',
      resourceName: 'player.png',
      attribution: 'Example Artist',
    });

    expect(result.imported).toBe(true);
    expect(result.download.sha256).toBe('a'.repeat(64));
    expect(result.provenance.attribution).toBe('Example Artist');
    expect(importLocalResource).toHaveBeenCalledTimes(1);
    expect(temporaryPath).not.toBeNull();
    expect(fs.existsSync(temporaryPath)).toBe(false);
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('delegates replace and requires a saved project before network access', async () => {
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-remote-replace-')
    );
    const downloader = jest.fn(async () => makeDownload());
    const replaceLocalResource = jest.fn(async request => ({
      replaced: true,
      resource: { name: request.resourceName },
    }));
    const service = createRemoteResourceService({
      // $FlowFixMe[incompatible-type]
      project: { getProjectFile: () => path.join(projectFolder, 'game.json') },
      assetTools: { importLocalResource: jest.fn(), replaceLocalResource },
      downloader,
    });
    await service.replaceUrl({
      url: 'https://cdn.example.com/player.png',
      resourceName: 'player.png',
      deletePreviousFile: false,
    });
    expect(replaceLocalResource).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceName: 'player.png',
        copyToProject: true,
        origin: {
          name: 'remote-url',
          identifier: 'https://cdn.example.com/player.png',
        },
      })
    );

    const unsavedDownloader = jest.fn();
    const unsaved = createRemoteResourceService({
      // $FlowFixMe[incompatible-type]
      project: { getProjectFile: () => '' },
      assetTools: {},
      downloader: unsavedDownloader,
    });
    await expect(
      unsaved.importUrl({ url: 'https://example.com/a.png' })
    ).rejects.toMatchObject({ code: 'remote_resource_requires_saved_project' });
    expect(unsavedDownloader).not.toHaveBeenCalled();
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });
});
