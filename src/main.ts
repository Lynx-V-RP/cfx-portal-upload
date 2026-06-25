import * as core from '@actions/core'
import puppeteer from 'puppeteer'
import type { Browser, Page } from 'puppeteer'
import FormData from 'form-data'
import axios from 'axios'

import { createReadStream, statSync, createWriteStream } from 'fs'
import { basename } from 'path'
import { ReUploadResponse, SSOResponseBody } from './types.js'
import {
  deleteIfExists,
  resolveAssetId,
  getEnv,
  getUrl,
  preparePuppeteer,
  zipAsset,
  isBetaAsset,
  getFxManifestVersion,
  getChangelog,
  getAssetVersions,
  deleteAssetVersion,
  portalApiHeaders
} from './utils.js'

const NAVIGATION_TIMEOUT_MS = 60_000
const PORTAL_ORIGIN = 'https://portal.cfx.re'
const EXPIRED_COOKIE_MESSAGE =
  'FORUM_COOKIE expiré ou invalide. Connectez-vous sur forum.cfx.re, copiez le cookie _t (DevTools → Application → Cookies), mettez à jour le secret GitHub FORUM_COOKIE, puis relancez le workflow « Escrow — refresh cookie ».'
const PORTAL_API_UNAUTHORIZED =
  'Session portal API refusée (401). Mettez à jour FORUM_COOKIE (cookie _t sur forum.cfx.re), vérifiez que le compte forum a accès à portal.cfx.re / escrow, et que l\'asset existe (ex. atlas_blackout_dev).'

async function gotoPage(
  page: Page,
  url: string,
  waitUntil: 'domcontentloaded' | 'networkidle0' = 'domcontentloaded'
): Promise<void> {
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
  await page.goto(url, {
    waitUntil,
    timeout: NAVIGATION_TIMEOUT_MS
  })
}

async function waitForPortal(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => window.location.href.includes('portal.cfx.re'),
      { timeout: NAVIGATION_TIMEOUT_MS }
    )
    return true
  } catch {
    return page.url().includes('portal.cfx.re')
  }
}

async function establishPortalSession(page: Page): Promise<void> {
  core.info('Initialisation de la session portal...')

  const apiReady = page
    .waitForResponse(
      res =>
        res.url().includes('portal-api.cfx.re') &&
        res.status() >= 200 &&
        res.status() < 400,
      { timeout: NAVIGATION_TIMEOUT_MS }
    )
    .then(() => true)
    .catch(() => false)

  await gotoPage(
    page,
    `${PORTAL_ORIGIN}/assets/created-assets`,
    'networkidle0'
  )

  if (await apiReady) {
    core.info('Requête portal-api confirmée.')
  } else {
    core.warning(
      'Aucune requête portal-api détectée — attente supplémentaire...'
    )
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}

async function verifyPortalApiSession(
  page: Page,
  cookies: string
): Promise<void> {
  try {
    await axios.get('https://portal-api.cfx.re/v1/me/assets?limit=1', {
      headers: portalApiHeaders(cookies)
    })
    core.info('Session portal API validée.')
    return
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) {
      throw error
    }
  }

  const browserStatus = await page.evaluate(async () => {
    const res = await fetch(
      'https://portal-api.cfx.re/v1/me/assets?limit=1',
      { credentials: 'include' }
    )
    return res.status
  })

  if (browserStatus === 401 || browserStatus === 403) {
    throw new Error(PORTAL_API_UNAUTHORIZED)
  }

  if (browserStatus >= 400) {
    throw new Error(
      `Session portal API invalide (HTTP ${browserStatus}). ${PORTAL_API_UNAUTHORIZED}`
    )
  }

  core.info('Session portal API validée via le navigateur.')
}

async function publishRefreshedCookie(browser: Browser): Promise<void> {
  const cookies = await browser.cookies()
  const authCookie = cookies.find(
    cookie => cookie.name === '_t' && cookie.domain.includes('cfx.re')
  )

  if (!authCookie?.value) {
    core.warning('Cookie _t introuvable après connexion — secret non rafraîchi.')
    return
  }

  core.setOutput('refreshed-cookie', authCookie.value)
  core.info('Cookie _t rafraîchi (output refreshed-cookie).')
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  let browser: Browser | undefined

  try {
    const executablePath = await preparePuppeteer()

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })

    const page = await browser.newPage()

    let assetId = core.getInput('assetId')
    let assetName = core.getInput('assetName')

    let zipPath = core.getInput('zipPath')
    const makeZip = core.getInput('makeZip').toLowerCase() === 'true'
    const skipUpload = core.getInput('skipUpload').toLowerCase() === 'true'
    const shouldDownload = core.getInput('download').toLowerCase() === 'true'
    const downloadPath =
      core.getInput('downloadPath') || `asset-${assetId || 'download'}.zip`
    const deleteOlderVersions =
      core.getInput('deleteOlderVersions').toLowerCase() === 'true'

    const chunkSize = parseInt(core.getInput('chunkSize'))
    const maxRetries = parseInt(core.getInput('maxRetries'))

    if (isNaN(chunkSize)) {
      throw new Error('Invalid chunk size. Must be a number.')
    }

    if (isNaN(maxRetries)) {
      throw new Error('Invalid max retries. Must be a number.')
    }

    if (skipUpload) {
      await loginToPortal(browser, page, maxRetries)
      await publishRefreshedCookie(browser)
      core.info('Skipping upload...')
      return
    }

    const betaInput = core.getInput('beta').toLowerCase()
    let beta = false

    if (betaInput === 'true') {
      beta = true
    } else if (betaInput === 'false') {
      beta = false
    } else {
      beta = await isBetaAsset(zipPath)
    }

    const changelog = await getChangelog(zipPath)

    // No asset id or name provided, using the repository name
    if (!assetId && !assetName) {
      core.debug('No asset id or name provided, using repository name...')
      assetName = basename(getEnv('GITHUB_WORKSPACE'))
    }

    const version = await getFxManifestVersion(zipPath)

    await loginToPortal(browser, page, maxRetries)
    await publishRefreshedCookie(browser)

    core.info('Redirected to CFX Portal. Uploading file ...')
    const cookies = await getCookies(browser)
    await verifyPortalApiSession(page, cookies)

    if (assetName) {
      assetId = await resolveAssetId(assetName, cookies)
    }

    zipPath = await getZipPath(assetName, zipPath, makeZip)
    const uploadedVersionId = await uploadZip(
      zipPath,
      assetId,
      chunkSize,
      cookies,
      beta,
      version,
      changelog
    )

    if (deleteOlderVersions) {
      core.info('Deleting older versions ...')
      const versions = await getAssetVersions(assetId, cookies)
      for (const v of versions) {
        if (v.id !== uploadedVersionId) {
          await deleteAssetVersion(assetId, v.id, cookies)
        }
      }
    }

      if (shouldDownload) {
        await waitForAssetReady(
          assetId,
          cookies,
          120000,
          5000,
          assetName,
          uploadedVersionId
        )
        await downloadAsset(
          assetId,
          cookies,
          downloadPath,
          uploadedVersionId
        )
      }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      type ErrorData = {
        message?: string
        errors?: string
      }

      const status = error.response?.status
      const data = error.response?.data as ErrorData | undefined
      const message = error.message

      core.error(`API Request failed [${status}]: ${message}`)
      if (data) {
        core.error(`Response body: ${JSON.stringify(data, null, 2)}`)
      }

      core.setFailed(
        status === 401
          ? PORTAL_API_UNAUTHORIZED
          : data?.message || data?.errors || message || 'Unknown error'
      )
    } else if (error instanceof Error) {
      if (error.message.includes('Navigation timeout')) {
        core.setFailed(EXPIRED_COOKIE_MESSAGE)
      } else {
        core.setFailed(error.message)
      }
    }
  } finally {
    await browser?.close()
  }
}

/**
 * Logs in to the CFX Portal and waits for the page to load.
 * If the login fails, it will retry up to `maxRetries` times.
 * @param browser
 * @param page
 * @param maxRetries
 * @throws If the login fails after `maxRetries` attempts.
 */
async function loginToPortal(
  browser: Browser,
  page: Page,
  maxRetries: number
): Promise<void> {
  const redirectUrl = await getRedirectUrl(page, maxRetries)
  await setForumCookie(browser, page)

  await gotoPage(page, redirectUrl, 'networkidle0')

  if (!(await waitForPortal(page))) {
    const currentUrl = page.url()
    if (currentUrl.includes('forum.cfx.re') || currentUrl.includes('login')) {
      throw new Error(EXPIRED_COOKIE_MESSAGE)
    }

    throw new Error(
      `Échec de redirection vers le portal (${currentUrl}). ${EXPIRED_COOKIE_MESSAGE}`
    )
  }

  core.info('Redirected to CFX Portal.')
  await establishPortalSession(page)
}

/**
 * Navigates to the SSO URL and waits for the page to load.
 * If the navigation fails, it will retry up to `maxRetries` times.
 * @param page
 * @param maxRetries
 * @returns {Promise<string>} The redirect URL.
 * @throws If the navigation fails after `maxRetries` attempts.
 */
async function getRedirectUrl(page: Page, maxRetries: number): Promise<string> {
  let loaded = false
  let attempt = 0
  let redirectUrl = null

  while (!loaded && attempt < maxRetries) {
    try {
      core.info('Navigating to SSO URL ...')

      await gotoPage(page, getUrl('SSO'), 'networkidle0')

      core.info('Navigated to SSO URL. Parsing response body ...')

      const responseBody = await page.evaluate(
        () => JSON.parse(document.body.innerText) as SSOResponseBody
      )

      core.debug('Parsed response body.')

      redirectUrl = responseBody.url

      core.info('Redirected to Forum Origin ...')

      const forumUrl = new URL(redirectUrl).origin
      await gotoPage(page, forumUrl)

      loaded = true
    } catch {
      core.info(`Failed to navigate to SSO URL. Retrying in 1 seconds...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      attempt++
    }
  }

  if (!loaded || redirectUrl == null) {
    throw new Error(
      `Failed to navigate to SSO URL after ${maxRetries} attempts.`
    )
  }

  return redirectUrl
}

/**
 * Sets the cookie for the cfx.re login.
 * @param browser
 * @param page
 * @returns {Promise<void>} Resolves when the cookie has been set.
 */
async function setForumCookie(browser: Browser, page: Page): Promise<void> {
  core.info('Setting cookies ...')

  await browser.setCookie({
    name: '_t',
    value: core.getInput('cookie'),
    domain: 'forum.cfx.re',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true
  })

  await page.evaluate(() => document.write('Cookie' + document.cookie))

  core.info('Cookies set. Following redirect...')
}

/**
 * Gets the cookies from the browser for portal API requests.
 * @param browser
 * @returns {Promise<string>} Resolves with the cookies as a string.
 */
async function getCookies(browser: Browser): Promise<string> {
  const cookieUrls = [
    PORTAL_ORIGIN,
    'https://portal-api.cfx.re',
    'https://forum.cfx.re'
  ]

  let cookies = await browser.cookies(...cookieUrls)
  if (cookies.length === 0) {
    cookies = await browser.cookies()
  }

  const byName = new Map<string, (typeof cookies)[number]>()
  for (const cookie of cookies) {
    if (!cookie.domain.includes('cfx.re')) {
      continue
    }
    byName.set(cookie.name, cookie)
  }

  const cookieHeader = [...byName.values()]
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')

  core.debug(
    `Cookies portal (${byName.size}): ${[...byName.keys()].join(', ') || 'aucun'}`
  )

  if (!byName.has('_t')) {
    core.warning('Cookie _t absent du jar — la session API peut échouer.')
  }

  return cookieHeader
}

/**
 * Retrieves the zipPath or creates a zip based on the provided parameters.
 * @param assetName - The name of the asset.
 * @param zipPath - The path to the zip file.
 * @param makeZip - Flag indicating whether to create a zip file.
 * @returns {Promise<string>} Resolves with the path to the zip file.
 * @throws If neither zipPath nor makeZip is provided, or if the pre-zip command fails.
 */
async function getZipPath(
  assetName: string,
  zipPath: string,
  makeZip: boolean
): Promise<string> {
  core.debug('Zip path: ' + JSON.stringify(zipPath))
  if (zipPath.length > 0) {
    core.debug('Using provided zip path.')
    return zipPath
  }

  if (!makeZip && zipPath.length == 0) {
    throw new Error(
      'Either zipPath or makeZip must be provided to upload a file.'
    )
  }

  core.info('Creating zip file ...')

  // Clean up github things before zipping
  deleteIfExists('.git/')
  deleteIfExists('.github/')
  deleteIfExists('.vscode/')

  return zipAsset(assetName)
}

/**
 * Starts the re-upload process by uploading the asset in chunks.
 * @param zipPath
 * @param assetId
 * @param chunkSize
 * @param cookies
 * @param beta
 * @param version
 * @param changelog
 * @returns {Promise<[number, number]>} Resolves when the re-upload process is initiated successfully.
 * @throws If the re-upload fails due to errors in the response.
 */
async function startReupload(
  zipPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  beta: boolean,
  version: string,
  changelog: string
): Promise<[number, number]> {
  const stats = statSync(zipPath)
  const totalSize = stats.size
  const originalFileName = basename(zipPath)
  const chunkCount = Math.ceil(totalSize / chunkSize)

  core.info('Starting upload ...')

  core.debug(`Total size: ${totalSize}`)
  core.debug(`Original file name: ${originalFileName}`)
  core.debug(`Chunk size: ${chunkSize}`)
  core.debug(`Chunk count: ${chunkCount}`)
  core.debug(`Beta: ${beta}`)
  core.debug(`Version: ${version}`)
  core.debug(`Changelog: ${changelog}`)

  const reUploadResponse = await axios.post<ReUploadResponse>(
    getUrl('REUPLOAD', { id: assetId }),
    {
      chunk_count: chunkCount,
      chunk_size: chunkSize,
      name: originalFileName,
      original_file_name: originalFileName,
      total_size: totalSize,

      release_candidate: beta,
      version: version,
      changelog: changelog
    },
    {
      headers: portalApiHeaders(cookies)
    }
  )

  if (reUploadResponse.data.errors !== null) {
    core.debug(JSON.stringify(reUploadResponse.data.errors))
    throw new Error(
      'Failed to re-upload file. See debug logs for more information.'
    )
  }

  return [reUploadResponse.data.asset_id, reUploadResponse.data.version_id]
}

/**
 * Uploads a zip file in chunks to the specified asset.
 * @param zipPath
 * @param assetId
 * @param chunkSize.
 * @param cookies
 * @param beta
 * @param version
 * @param changelog
 * @returns {Promise<number>} Resolves with the uploaded version ID when the upload is complete.
 * @throws If the upload fails at any stage.
 */
async function uploadZip(
  zipPath: string,
  assetId: string,
  chunkSize: number,
  cookies: string,
  beta: boolean,
  version: string,
  changelog: string
): Promise<number> {
  const [assetIdReupload, versionId] = await startReupload(
    zipPath,
    assetId,
    chunkSize,
    cookies,
    beta,
    version,
    changelog
  )

  let chunkIndex = 0

  const stats = statSync(zipPath)
  const totalSize = stats.size
  const chunkCount = Math.ceil(totalSize / chunkSize)

  const stream = createReadStream(zipPath, { highWaterMark: chunkSize })

  for await (const chunk of stream) {
    const form = new FormData()
    form.append('chunk_id', chunkIndex)
    form.append('chunk', chunk, {
      filename: 'blob',
      contentType: 'application/octet-stream'
    })

    await axios.post(
      getUrl('UPLOAD_CHUNK', { id: assetIdReupload, version_id: versionId }),
      form,
      {
        headers: {
          ...form.getHeaders(),
          ...portalApiHeaders(cookies)
        }
      }
    )

    core.info(`Uploaded chunk ${chunkIndex + 1}/${chunkCount}`)

    chunkIndex++
  }

  await completeUpload(assetIdReupload, versionId, cookies)

  return versionId
}

/**
 * Completes the upload process.
 * @param assetId
 * @param versionId
 * @param cookies
 * @returns {Promise<void>} Resolves when the upload is complete.
 */
async function completeUpload(
  assetId: number,
  versionId: number,
  cookies: string
): Promise<void> {
  await axios.post(
    getUrl('COMPLETE_UPLOAD', { id: assetId, version_id: versionId }),
    {},
    {
      headers: portalApiHeaders(cookies)
    }
  )

  core.info('Upload completed.')
}

/**
 * Polls the assets endpoint to check if the asset is ready.
 * The asset is considered ready if its state is 'active'.
 * If assetName is provided, it will use it as a search parameter.
 * Otherwise, it will scan through pages until it finds the asset.
 *
 * @param assetId The asset id to search for.
 * @param cookies Cookies for authentication.
 * @param timeout Time in milliseconds to wait for the asset to become ready.
 * @param interval Polling interval in milliseconds.
 * @param assetName (Optional) The asset name to use in the search.
 * @throws If the asset is not ready within the timeout period.
 */
async function waitForAssetReady(
  assetId: string,
  cookies: string,
  timeout = 60000,
  interval = 5000,
  assetName?: string,
  versionId?: number
): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const versions = await getAssetVersions(assetId, cookies)
    const version = versionId
      ? versions?.find(v => v.id === versionId)
      : versions?.find(v => v.state === 'active')

    if (version) {
      core.info(
        `Version ${version.version ?? version.id} state: ${version.state}`
      )
      if (version.state === 'active' && version.packs?.length) {
        core.info('Asset is ready for download.')
        return
      }
    } else {
      core.info(
        assetName
          ? `Version active introuvable pour ${assetName}. Waiting...`
          : 'Version not found. Waiting...'
      )
    }

    await new Promise(resolve => setTimeout(resolve, interval))
  }

  throw new Error(
    'Asset was not ready for download within the specified timeout.'
  )
}

async function resolveDownloadPack(
  assetId: string,
  cookies: string,
  versionId?: number
): Promise<{ versionId: number; packId: number }> {
  const versions = await getAssetVersions(assetId, cookies)
  const version = versionId
    ? versions?.find(v => v.id === versionId)
    : versions?.find(v => v.state === 'active')

  if (!version?.packs?.length) {
    throw new Error(
      `Aucun pack téléchargeable pour l'asset ${assetId}` +
        (versionId ? ` (version ${versionId})` : '')
    )
  }

  return { versionId: version.id, packId: version.packs[0].id }
}

/**
 * Downloads the encrypted pack from the portal (escrow).
 * Uses /assets/{id}/versions/{version_id}/packs/{pack_id}/download
 * — /assets/{id}/download returns 404 for escrow assets.
 */
async function downloadAsset(
  assetId: string,
  cookies: string,
  downloadPath: string,
  versionId?: number
): Promise<void> {
  const { versionId: vid, packId } = await resolveDownloadPack(
    assetId,
    cookies,
    versionId
  )

  const portalDownloadUrl = getUrl('PACK_DOWNLOAD', {
    id: assetId,
    version_id: vid,
    pack_id: packId
  })
  core.info(`Fetching download URL from ${portalDownloadUrl} ...`)

  const initialResponse = await axios.get<{ url: string }>(portalDownloadUrl, {
    headers: portalApiHeaders(cookies),
    responseType: 'json'
  })

  const realDownloadUrl = initialResponse.data.url
  if (!realDownloadUrl) {
    throw new Error('URL de téléchargement manquante dans la réponse portal')
  }

  core.info(`Downloading asset from ${realDownloadUrl} ...`)

  const response = await axios.get(realDownloadUrl, {
    responseType: 'stream'
  })

  const writer = createWriteStream(downloadPath)
  response.data.pipe(writer)

  await new Promise<void>((resolve, reject) => {
    writer.on('finish', () => resolve())
    writer.on('error', reject)
  })

  core.info(`Downloaded asset saved to ${downloadPath}`)
}
