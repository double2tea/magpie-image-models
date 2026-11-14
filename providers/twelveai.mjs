import {
  createOpenAICompatibleImageProvider,
  dataURI,
  downloadAsBase64,
  errorResponse,
  fileByField,
  imageRefs,
  jsonResponse,
  maskFile,
  pollUntil,
  readImageRequest,
  requestFields,
  requestFiles,
  validateImageRequest,
} from "../common.mjs"
import { modelCapabilities, modelEntries } from "../catalog.mjs"

const PROVIDER = "image-models/twelveai"
const BASE = "https://cdn.12ai.org"
const MODELS = modelEntries(PROVIDER).map(([id, name]) => [id, name, modelCapabilities(PROVIDER, id),
  { size: id.startsWith("gemini-") ? "aspect-resolution" : "pixels" }])

function isGemini(model) {
  return model.startsWith("gemini-")
}

function buildInput(fields, files, model, size) {
  const input = { prompt: String(fields.prompt || "") }
  const refs = imageRefs(fields, files)
  if (refs.length) {
    input.images = refs.map((ref) => {
      if (ref.kind === "bytes") return dataURI(ref.bytes, ref.mime)
      if (ref.value.startsWith("data:") || ref.value.startsWith("https://") || ref.value.startsWith("http://")) return ref.value
      throw Object.assign(new Error("reference images must be HTTPS URLs or data URIs"), { status: 400 })
    })
  }
  if (isGemini(model)) {
    const aspect = fields.aspect_ratio || fields.aspectRatio || size?.aspect
    const imageSize = fields.resolution || fields.image_size || fields.imageSize || size?.tier
    if (aspect) input.aspect_ratio = aspect
    if (imageSize) input.image_size = imageSize
  } else {
    for (const key of ["size", "quality", "background", "output_format"]) {
      if (fields[key] !== undefined && fields[key] !== "") input[key] = fields[key]
    }
    if (size?.width) input.size = `${size.width}x${size.height}`
    if (fields.output_format) input.output_format = String(fields.output_format).toLowerCase()
    for (const key of ["n", "frame_count", "frame_duration_ms"]) {
      if (fields[key] === undefined || fields[key] === "") continue
      const value = Number(fields[key])
      if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error(`${key} must be a positive integer`), { status: 400 })
      input[key] = value
    }
    const mask = maskFile(files)
    if (mask) input.mask = dataURI(mask.bytes, mask.mime)
    else if (fields.mask || fields.mask_url) input.mask = fields.mask || fields.mask_url
    const markup = fileByField(files, "markup")
    if (markup) input.markup = dataURI(markup.bytes, markup.mime)
    else if (typeof fields.markup === "string" && fields.markup) input.markup = fields.markup
  }
  if (fields.n !== undefined && input.n === undefined) {
    const value = Number(fields.n)
    if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error("n must be a positive integer"), { status: 400 })
    input.n = value
  }
  return input
}

async function postJSON(url, key, body, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`12ai returned HTTP ${response.status} with non-JSON output`)
  }
  if (!response.ok) throw new Error(`12ai returned HTTP ${response.status}: ${value.error?.message || value.message || "request failed"}`)
  return value
}

async function getJSON(url, key, signal) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
    },
    signal,
  })
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`12ai returned HTTP ${response.status} with non-JSON output`)
  }
  if (!response.ok) throw new Error(`12ai returned HTTP ${response.status}: ${value.error?.message || value.message || "request failed"}`)
  return value
}

function outputsOf(value) {
  const rows = Array.isArray(value.outputs) ? value.outputs : []
  return rows.map((row) => typeof row === "string" ? row : row?.url || row?.output || row?.href).filter(Boolean)
}

async function generate({ requestURL, init, key, provider, base }) {
  const request = await readImageRequest(requestURL, init)
  if (!request.path.endsWith("/images/generations") && !request.path.endsWith("/images/edits")) {
    return errorResponse(404, `${provider} serves only /images/generations and /images/edits`)
  }
  if ((init.method || "POST").toUpperCase() !== "POST") return errorResponse(405, "use POST to generate an image")
  const fields = requestFields(request)
  if (fields.complexity) return errorResponse(400, "12ai complexity support is not verified through this plugin")
  const model = String(fields.model || "").trim()
  if (!MODELS.some(([id]) => id === model)) return errorResponse(400, `choose one of the ${provider} models`)
  const files = requestFiles(request)
  const capabilities = modelCapabilities(provider, model)
  const { size } = validateImageRequest({ provider, model, fields, files, capabilities,
    sizeMode: isGemini(model) ? "aspect-resolution" : "pixels", requestPath: request.path })
  const input = buildInput(fields, files, model, size)
  const submitted = await postJSON(`${base}/v1/task/submit`, key, { model, input }, init.signal)
  const taskId = submitted.id || submitted.task_id
  if (!taskId) throw new Error("12ai returned no task id")
  const result = await pollUntil({
    signal: init.signal,
    get: () => getJSON(`${base}/v1/task/${encodeURIComponent(taskId)}`, key, init.signal),
    done: (value) => ["completed", "partial_completed", "succeeded", "success"].includes(String(value.status || "").toLowerCase()),
    failed: (value) => ["failed", "error", "cancelled", "canceled"].includes(String(value.status || "").toLowerCase())
      ? String(value.error?.message || value.message || value.status)
      : "",
  })
  const outputs = outputsOf(result)
  if (!outputs.length) throw new Error("12ai completed without an image output")
  const data = []
  for (const url of outputs) data.push(await downloadAsBase64(url, { authorization: `Bearer ${key}` }, init.signal))
  return jsonResponse({ created: Math.floor(Date.now() / 1000), data })
}

export async function TwelveAIImages(input, options = {}) {
  return provider(input, options)
}

const provider = createOpenAICompatibleImageProvider({
  id: PROVIDER,
  name: "12ai Images",
  base: BASE,
  models: MODELS,
  generate,
  label: "12ai API key",
  labelZh: "12ai API Key",
  placeholder: "sk-…",
})
