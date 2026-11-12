import {
  createOpenAICompatibleImageProvider,
  dataURI,
  downloadAsBase64,
  errorResponse,
  imageRefs,
  jsonResponse,
  maskFile,
  pollUntil,
  readImageRequest,
  requestFields,
  requestFiles,
  sizeInfo,
} from "../common.mjs"

const PROVIDER = "image-models/twelveai"
const BASE = "https://cdn.12ai.org"
const MODELS = [
  ["gemini-nano-banana-2.1", "Nano Banana 2.1"],
  ["gemini-3.1-flash-image-preview", "Nano Banana 2 Preview"],
  ["gemini-3.1-flash-image", "Nano Banana 2"],
  ["gemini-3.1-flash-lite-image", "Nano Banana Lite"],
  ["gemini-3-pro-image-preview", "Nano Banana Pro Preview"],
  ["gemini-3-pro-image", "Nano Banana Pro"],
  ["gpt-image-2.6-flare", "GPT Image 2.6 Flare"],
  ["gpt-image-2.6-sunburst", "GPT Image 2.6 Sunburst"],
  ["gpt-image-2.5-flare", "GPT Image 2.5 Flare"],
  ["gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"],
  ["gpt-image-2", "GPT Image 2"],
]

function isGemini(model) {
  return model.startsWith("gemini-")
}

function buildInput(fields, files, model) {
  const input = { prompt: String(fields.prompt || "") }
  if (!input.prompt.trim()) throw Object.assign(new Error("prompt is required"), { status: 400 })
  const refs = imageRefs(fields, files)
  if (refs.length) {
    input.images = refs.map((ref) => {
      if (ref.kind === "bytes") return dataURI(ref.bytes, ref.mime)
      if (ref.value.startsWith("data:") || ref.value.startsWith("https://") || ref.value.startsWith("http://")) return ref.value
      throw Object.assign(new Error("reference images must be HTTPS URLs or data URIs"), { status: 400 })
    })
  }
  const size = sizeInfo(fields.size)
  if (isGemini(model)) {
    const aspect = fields.aspect_ratio || fields.aspectRatio || size?.aspect
    const imageSize = fields.image_size || fields.imageSize || size?.tier
    if (aspect) input.aspect_ratio = aspect
    if (imageSize) input.image_size = imageSize
  } else {
    for (const key of ["size", "quality", "background", "output_format"]) {
      if (fields[key] !== undefined && fields[key] !== "") input[key] = fields[key]
    }
    for (const key of ["n", "frame_count", "frame_duration_ms"]) {
      if (fields[key] === undefined || fields[key] === "") continue
      const value = Number(fields[key])
      if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error(`${key} must be a positive integer`), { status: 400 })
      input[key] = value
    }
    const mask = maskFile(files)
    if (mask) input.mask = dataURI(mask.bytes, mask.mime)
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
  const model = String(fields.model || "").trim()
  if (!MODELS.some(([id]) => id === model)) return errorResponse(400, `choose one of the ${provider} models`)
  const input = buildInput(fields, requestFiles(request), model)
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
})
