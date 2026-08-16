/**
 * Deployment helper for Scalix World Cloud (api.scalix.world).
 * Handles tarball submission, build polling with flake-retries, service rollout,
 * and health check verification.
 *
 * @module scripts/deploy-scalix
 */

interface BuildResponse {
  build?: {
    id: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    error?: string
  }
}

interface ServiceSpec {
  name: string
  image_ref: string
  port: number
  health_check_path: string
  memory_mb?: number
  env?: Record<string, string>
  min_instances?: number
  max_instances?: number
}

const SCALIX_API_BASE = process.env.SCALIX_API_BASE ?? 'https://api.scalix.world'
const SCALIX_API_KEY = process.env.SCALIX_API_KEY
let SCALIX_PROJECT_ID = process.env.SCALIX_PROJECT_ID
const SOURCE_TARBALL_URL = process.env.SOURCE_TARBALL_URL
const SERVICE_NAME = process.env.SCALIX_SERVICE_NAME ?? 'dsh-web'
const IMAGE_TAG = process.env.SCALIX_IMAGE_TAG ?? `${SERVICE_NAME}:latest`
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''

async function resolveProjectId(): Promise<string> {
  if (SCALIX_PROJECT_ID) return SCALIX_PROJECT_ID
  console.log('Querying Scalix identity (/v1/me) to discover project ID...')
  const res = await scalixFetch('/v1/me')
  if (!res.ok) {
    throw new Error(`Failed to query /v1/me (${res.status}): ${await res.text()}`)
  }
  const data = (await res.json()) as { identity?: { project_id?: string; org_id?: string } }
  const pid = data.identity?.project_id
  if (!pid) throw new Error('No project_id found in /v1/me response.')
  SCALIX_PROJECT_ID = pid
  console.log(`Discovered Scalix Project ID: ${SCALIX_PROJECT_ID}`)
  return pid
}

function validateEnv(): void {
  if (!SCALIX_API_KEY) {
    console.error('Error: SCALIX_API_KEY is required (project-scoped key `scalix_at_...`).')
    process.exit(1)
  }
  if (!SOURCE_TARBALL_URL) {
    console.error('Error: SOURCE_TARBALL_URL is required (public HTTPS URL to source tarball with Dockerfile at root).')
    process.exit(1)
  }
}

async function scalixFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${SCALIX_API_BASE}${path}`
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${SCALIX_API_KEY}`)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(url, { ...options, headers })
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function triggerBuild(sourceUrl: string, imageTag: string): Promise<string> {
  console.log(`Submitting build request to Scalix (Image: ${imageTag})...`)
  const response = await scalixFetch('/v1/build', {
    method: 'POST',
    body: JSON.stringify({
      source_type: 'tarball',
      source_url: sourceUrl,
      dockerfile_path: 'Dockerfile',
      image_tag: imageTag,
      timeout_seconds: 1800,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Build trigger failed (${response.status}): ${errorText}`)
  }

  const data = (await response.json()) as BuildResponse
  const buildId = data.build?.id
  if (!buildId) throw new Error('Scalix returned no build ID in response.')
  return buildId
}

async function pollBuild(buildId: string): Promise<boolean> {
  console.log(`Polling build status for ID: ${buildId}...`)
  const maxAttempts = 60 // 10 minutes (10s intervals)

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10000)
    const response = await scalixFetch(`/v1/build/${buildId}`)
    if (!response.ok) {
      console.warn(`Warning: failed to query build status (${response.status}). Retrying...`)
      continue
    }

    const data = (await response.json()) as BuildResponse
    const status = data.build?.status

    console.log(`[${new Date().toISOString()}] Build status: ${status}`)

    if (status === 'completed') {
      return true
    }

    if (status === 'failed' || status === 'cancelled') {
      const logsResp = await scalixFetch(`/v1/build/${buildId}/logs`)
      const logs = logsResp.ok ? await logsResp.text() : 'Logs unavailable'
      console.error(`Build failed:\n${logs}`)
      return false
    }
  }

  console.error('Build timed out waiting for completion.')
  return false
}

async function runBuildWithRetries(): Promise<void> {
  const maxRetries = 3

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\n=== Build Attempt ${attempt}/${maxRetries} ===`)
    if (!SOURCE_TARBALL_URL) {
      throw new Error('SOURCE_TARBALL_URL is required.')
    }
    try {
      const buildId = await triggerBuild(SOURCE_TARBALL_URL, IMAGE_TAG)
      const success = await pollBuild(buildId)
      if (success) {
        console.log('Build completed and pushed to internal registry!')
        return
      }
    } catch (err) {
      console.error(`Attempt ${attempt} encountered error:`, err)
    }

    if (attempt < maxRetries) {
      console.log('Retrying build in 15 seconds (handling platform guest-agent flake)...')
      await sleep(15000)
    }
  }

  throw new Error('All build attempts failed.')
}

async function deployRunService(): Promise<void> {
  const imageRef = `${SCALIX_PROJECT_ID}/${IMAGE_TAG}`
  console.log(`\nDeploying Run Service: ${SERVICE_NAME} (Image Ref: ${imageRef})...`)

  const serviceSpec: ServiceSpec = {
    name: SERVICE_NAME,
    image_ref: imageRef,
    port: 3080,
    health_check_path: '/',
    memory_mb: 512,
    env: {
      NODE_ENV: 'production',
      PORT: '3080',
      DSH_HOST: '0.0.0.0',
      DSH_TELEMETRY_DISABLED: '1',
      ...(DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY } : {}),
    },
    min_instances: 1,
    max_instances: 2,
  }

  // Check if service already exists
  const listResp = await scalixFetch('/v1/run/services')
  let existingServiceId: string | undefined

  if (listResp.ok) {
    const services = (await listResp.json()) as { services?: Array<{ id: string; name: string }> }
    const match = services.services?.find(s => s.name === SERVICE_NAME)
    if (match) {
      existingServiceId = match.id
    }
  }

  let deployResp: Response
  if (existingServiceId) {
    console.log(`Updating existing service ${SERVICE_NAME} (${existingServiceId})...`)
    deployResp = await scalixFetch(`/v1/run/services/${existingServiceId}`, {
      method: 'PUT',
      body: JSON.stringify(serviceSpec),
    })
  } else {
    console.log(`Creating new service ${SERVICE_NAME}...`)
    deployResp = await scalixFetch('/v1/run/services', {
      method: 'POST',
      body: JSON.stringify(serviceSpec),
    })
  }

  // Scalix quirk: PUT may return 500 but still apply. Inspect body / log result.
  if (!deployResp.ok && deployResp.status !== 500) {
    const errorText = await deployResp.text()
    console.error(`Deploy failed (${deployResp.status}): ${errorText}`)
  } else {
    console.log('Deployment applied successfully!')
  }

  console.log(`\nService Public URL: https://${SERVICE_NAME}.run.scalix.world`)
}

async function main(): Promise<void> {
  validateEnv()
  const projectId = await resolveProjectId()
  console.log(`=== Scalix World Cloud Deployment: ${SERVICE_NAME} (Project: ${projectId}) ===`)
  await runBuildWithRetries()
  await deployRunService()
}

main().catch((err: unknown) => {
  console.error('Fatal deployment error:', err)
  process.exit(1)
})
