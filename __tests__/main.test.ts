/* eslint-disable @typescript-eslint/unbound-method */
import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import {
  registerAxiosMock,
  registerCoreMock,
  resetPackageMocks
} from './helpers/mocks.js'

const utilsMock = {
  deleteIfExists: jest.fn(),
  resolveAssetId: jest.fn(),
  getEnv: jest.fn(),
  getUrl: jest.fn(),
  preparePuppeteer: jest.fn(),
  zipAsset: jest.fn(),
  isBetaAsset: jest.fn(),
  getFxManifestVersion: jest.fn(),
  getChangelog: jest.fn(),
  getAssetVersions: jest.fn(),
  deleteAssetVersion: jest.fn()
}

const fsMock = {
  statSync: jest.fn(),
  createReadStream: jest.fn(),
  createWriteStream: jest.fn()
}

function mockEmptyUpload(): void {
  fsMock.statSync.mockReturnValue({ size: 0 })
  fsMock.createReadStream.mockReturnValue({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await Promise.resolve()
        return { done: true, value: undefined }
      }
    })
  })
}

registerCoreMock()
registerAxiosMock()
jest.unstable_mockModule('../src/utils.js', () => ({
  ...utilsMock,
  clearFileCache: jest.fn(),
  portalApiHeaders: (cookies: string) => ({
    Cookie: cookies,
    Origin: 'https://portal.cfx.re',
    Referer: 'https://portal.cfx.re/'
  })
}))
jest.unstable_mockModule('fs', () => {
  const actualFs = jest.requireActual<typeof import('fs')>('fs')
  return {
    ...actualFs,
    statSync: fsMock.statSync,
    createReadStream: fsMock.createReadStream,
    createWriteStream: fsMock.createWriteStream
  }
})

const core = await import('@actions/core')
const main = await import('../src/main.js')
const puppeteer = (await import('puppeteer')).default
const utils = await import('../src/utils.js')
const axios = (await import('axios')).default
const fs = await import('fs')

describe('main', () => {
  let browserMock: {
    newPage: jest.Mock
    close: jest.Mock
    setCookie: jest.Mock
    cookies: jest.Mock
  }
  let pageMock: {
    goto: jest.Mock
    evaluate: jest.Mock
    url: jest.Mock
    close: jest.Mock
    setDefaultNavigationTimeout: jest.Mock
    waitForFunction: jest.Mock
    waitForResponse: jest.Mock
  }

  beforeEach(() => {
    resetPackageMocks()
    Object.values(utilsMock).forEach(mock => mock.mockReset())
    Object.values(fsMock).forEach(mock => mock.mockReset())
    mockEmptyUpload()

    pageMock = {
      goto: jest.fn(),
      evaluate: jest.fn(),
      url: jest.fn().mockReturnValue('https://portal.cfx.re'),
      close: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      waitForResponse: jest.fn().mockResolvedValue({
        url: () => 'https://portal-api.cfx.re/v1/me/assets',
        status: () => 200
      })
    }

    browserMock = {
      newPage: jest.fn().mockResolvedValue(pageMock),
      close: jest.fn(),
      setCookie: jest.fn(),
      cookies: jest
        .fn()
        .mockResolvedValue([
          { name: '_t', value: 'test-cookie', domain: 'forum.cfx.re' }
        ])
    }
    ;(puppeteer.launch as jest.Mock).mockResolvedValue(browserMock)
    ;(utils.preparePuppeteer as jest.Mock).mockResolvedValue('/chrome')
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '3'
        case 'makeZip':
          return 'false'
        case 'skipUpload':
          return 'false'
        case 'deleteOlderVersions':
          return 'false'
        case 'beta':
          return 'false'
        default:
          return ''
      }
    })
    ;(utils.getUrl as jest.Mock).mockImplementation((type: string) => {
      if (type === 'SSO') return 'https://sso-url'
      return `https://api/${type}`
    })
    ;(axios.get as jest.Mock).mockResolvedValue({ data: { items: [] } })
  })

  it('should fail if chunkSize is not a number', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'chunkSize') return 'invalid'
      return ''
    })

    await main.run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'Invalid chunk size. Must be a number.'
    )
  })

  it('should fail if maxRetries is not a number', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'maxRetries') return 'invalid'
      if (name === 'chunkSize') return '1024'
      return ''
    })

    await main.run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'Invalid max retries. Must be a number.'
    )
  })

  it('should set beta to true if beta input is true', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'assetId':
          return '123'
        case 'zipPath':
          return 'test.zip'
        case 'beta':
          return 'true'
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '1'
        default:
          return ''
      }
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')
    ;(utils.getFxManifestVersion as jest.Mock).mockReturnValue('1.0.0')
    ;(utils.getChangelog as jest.Mock).mockReturnValue('test changelog')
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 0 })
    ;(axios.post as jest.Mock).mockResolvedValue({
      data: { asset_id: 123, version_id: 456, errors: null }
    })

    await main.run()

    expect(axios.post as jest.Mock).toHaveBeenCalledWith(
      expect.stringContaining('REUPLOAD'),
      expect.objectContaining({ release_candidate: true }),
      expect.anything()
    )
  })

  it('should successfully complete the upload flow', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'assetId':
          return '123'
        case 'zipPath':
          return 'test.zip'
        case 'cookie':
          return 'test-cookie'
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '1'
        default:
          return 'false'
      }
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')
    ;(utils.getFxManifestVersion as jest.Mock).mockReturnValue('1.0.0')
    ;(utils.getChangelog as jest.Mock).mockReturnValue('test changelog')
    ;(axios.post as jest.Mock).mockResolvedValue({
      data: {
        asset_id: 123,
        version_id: 456,
        errors: null
      }
    })
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 2048 })
    ;(fs.createReadStream as jest.Mock).mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await Promise.resolve()
        yield Buffer.from('chunk1')
        yield Buffer.from('chunk2')
      }
    })

    await main.run()

    expect(utils.preparePuppeteer).toHaveBeenCalled()
    expect(puppeteer.launch as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '/chrome'
      })
    )
    expect(pageMock.goto).toHaveBeenCalledWith(
      'https://sso-url',
      expect.anything()
    )
    expect(core.info).toHaveBeenCalledWith(
      'Redirected to CFX Portal. Uploading file ...'
    )
    expect(browserMock.close).toHaveBeenCalled()
  })

  it('should resolve assetId from assetName if assetId is not provided', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'assetName':
          return 'my-asset'
        case 'zipPath':
          return 'test.zip'
        case 'cookie':
          return 'test-cookie'
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '1'
        default:
          return ''
      }
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')
    ;(utils.resolveAssetId as jest.Mock).mockResolvedValue('789')
    ;(utils.getFxManifestVersion as jest.Mock).mockReturnValue('1.0.0')
    ;(utils.getChangelog as jest.Mock).mockReturnValue('test changelog')
    ;(axios.post as jest.Mock).mockResolvedValue({
      data: {
        asset_id: 789,
        version_id: 101,
        errors: null
      }
    })

    await main.run()

    expect(utils.resolveAssetId as jest.Mock).toHaveBeenCalledWith(
      'my-asset',
      expect.anything()
    )
    expect(core.info).toHaveBeenCalledWith(
      'Redirected to CFX Portal. Uploading file ...'
    )
  })

  it('should use provided zipPath and not call zipAsset', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'assetId':
          return '123'
        case 'zipPath':
          return 'provided.zip'
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '1'
        default:
          return ''
      }
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')
    ;(utils.getFxManifestVersion as jest.Mock).mockReturnValue('1.0.0')
    ;(axios.post as jest.Mock).mockResolvedValue({
      data: { asset_id: 123, version_id: 456, errors: null }
    })

    await main.run()

    expect(utils.zipAsset).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      'Redirected to CFX Portal. Uploading file ...'
    )
  })

  it('should delete older versions if deleteOlderVersions is true', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'assetId':
          return '123'
        case 'zipPath':
          return 'test.zip'
        case 'cookie':
          return 'test-cookie'
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '1'
        case 'deleteOlderVersions':
          return 'true'
        case 'makeZip':
        case 'skipUpload':
        case 'beta':
          return 'false'
        default:
          return ''
      }
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')
    ;(utils.getFxManifestVersion as jest.Mock).mockReturnValue('1.0.0')
    ;(utils.getChangelog as jest.Mock).mockReturnValue('test changelog')
    ;(axios.post as jest.Mock).mockResolvedValue({
      data: {
        asset_id: 123,
        version_id: 456,
        errors: null
      }
    })
    ;(utils.getAssetVersions as jest.Mock).mockResolvedValue([
      { id: 456, version: '1.0.0' },
      { id: 111, version: '0.9.0' }
    ])

    await main.run()

    expect(core.info).toHaveBeenCalledWith('Deleting older versions ...')
    expect(utils.deleteAssetVersion).toHaveBeenCalledWith(
      '123',
      111,
      expect.anything()
    )
    expect(utils.deleteAssetVersion).not.toHaveBeenCalledWith(
      '123',
      456,
      expect.anything()
    )
  })

  it('should skip upload if skipUpload is true', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'skipUpload') return 'true'
      if (name === 'chunkSize') return '1024'
      if (name === 'maxRetries') return '1'
      return ''
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')

    await main.run()

    expect(core.info).toHaveBeenCalledWith('Redirected to CFX Portal.')
    expect(core.info).toHaveBeenCalledWith('Skipping upload...')
    expect(axios.post).not.toHaveBeenCalled()
  })

  it('should download asset after upload when download is true', async () => {
    const mockWriter = {
      on: jest.fn((event: string, callback: () => void) => {
        if (event === 'finish') {
          callback()
        }
      })
    }
    const mockStream = {
      pipe: jest.fn()
    }

    fsMock.createWriteStream.mockReturnValue(mockWriter)
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'assetId':
          return '123'
        case 'zipPath':
          return 'test.zip'
        case 'cookie':
          return 'test-cookie'
        case 'chunkSize':
          return '1024'
        case 'maxRetries':
          return '1'
        case 'download':
          return 'true'
        case 'downloadPath':
          return 'downloaded.zip'
        default:
          return 'false'
      }
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')
    ;(utils.getFxManifestVersion as jest.Mock).mockReturnValue('1.0.0')
    ;(utils.getChangelog as jest.Mock).mockReturnValue('test changelog')
    ;(utils.getAssetVersions as jest.Mock).mockResolvedValue([
      { id: 456, state: 'active', version: '1.0.0', packs: [{ id: 99 }] }
    ])
    ;(axios.post as jest.Mock).mockResolvedValue({
      data: {
        asset_id: 123,
        version_id: 456,
        errors: null
      }
    })
    ;(axios.get as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/me/assets?limit=1')) {
        return Promise.resolve({ data: { items: [] } })
      }
      if (url.includes('PACK_DOWNLOAD') || url.includes('/packs/')) {
        return Promise.resolve({
          data: { url: 'https://cdn.example.com/asset.zip' }
        })
      }
      if (url === 'https://cdn.example.com/asset.zip') {
        return Promise.resolve({ data: mockStream })
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`))
    })

    await main.run()

    expect(axios.get as jest.Mock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/me/assets?limit=1'),
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: expect.any(String) })
      })
    )
    expect(axios.get as jest.Mock).toHaveBeenCalledWith(
      'https://api/PACK_DOWNLOAD',
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: expect.any(String) }),
        responseType: 'json'
      })
    )
    expect(axios.get as jest.Mock).toHaveBeenCalledWith(
      'https://cdn.example.com/asset.zip',
      expect.objectContaining({ responseType: 'stream' })
    )
    expect(fsMock.createWriteStream).toHaveBeenCalledWith('downloaded.zip')
    expect(mockStream.pipe).toHaveBeenCalledWith(mockWriter)
    expect(core.info).toHaveBeenCalledWith(
      'Downloaded asset saved to downloaded.zip'
    )
  })

  it('should handle axios errors gracefully', async () => {
    ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'chunkSize') return '1024'
      if (name === 'maxRetries') return '1'
      if (name === 'assetId') return '123'
      if (name === 'zipPath') return 'test.zip'
      return ''
    })

    pageMock.evaluate.mockResolvedValueOnce({ url: 'https://forum-redirect' })
    pageMock.url.mockReturnValue('https://portal.cfx.re')

    const mockError = new Error('API Error')
    const axiosError = mockError as unknown as {
      response: { status: number; data: { message: string } }
    }
    axiosError.response = {
      status: 500,
      data: { message: 'Internal Server Error' }
    }
    ;(axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true)
    ;(axios.post as jest.Mock).mockRejectedValueOnce(axiosError)
    ;(utils.getFxManifestVersion as jest.Mock).mockReturnValue('1.0.0')

    await main.run()

    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('API Request failed [500]')
    )
  })
})
