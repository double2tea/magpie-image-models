import fs from "node:fs"
import path from "node:path"

import {
  createOpenAICompatibleImageProvider,
  dataURI,
  downloadAsBase64,
  errorResponse,
  fileByField,
  imageRefs,
  jsonResponse,
  normalizeMime,
  parseDataURI,
  pollUntil,
  readImageRequest,
  requestFields,
  requestFiles,
  validateImageRequest,
} from "../common.mjs"
import { modelCapabilities, modelEntries } from "../catalog.mjs"

const PROVIDER = "image-models/wavespeed"
const BASE = "https://api.wavespeed.ai"
const MODELS = modelEntries(PROVIDER).map(([id, name]) => [id, name, modelCapabilities(PROVIDER, id),
  { size: "aspect-resolution" }])

function endpointFor(model, hasImages) {
  const editModel = modelCapabilities(PROVIDER, model).editModel
  if (hasImages && editModel) return editModel
  return model
}

function modelKind(model) {
  if (model.includes("ideogram")) return "ideogram"
  if (model.includes("seedream")) return "seedream"
  if (model.includes("h3-image")) return "h3"
  return "flux"
}

async function httpJSON(url, key, { method = "GET", body, signal } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`WaveSpeed returned HTTP ${response.status} with non-JSON output`)
  }
  if (!response.ok) throw new Error(`WaveSpeed returned HTTP ${response.status}: ${value.message || value.error?.message || "request failed"}`)
  if (value.code !== undefined && value.code !== 200) throw new Error(`WaveSpeed returned code ${value.code}: ${value.message || "request failed"}`)
  return value.data ?? value
}

async function upload(base, key, bytes, name, mime, signal) {
  const contentType = normalizeMime(mime) || "application/octet-stream"
  const ticket = await httpJSON(`${base}/api/v3/media/uploads`, key, {
    method: "POST",
    body: { filename: name || "image", size: bytes.length, content_type: contentType },
    signal,
  })
  const uploadURL = ticket.upload?.url
  const outputURL = ticket.download_url
  const headers = ticket.upload?.headers
  if (!uploadURL || !outputURL || !headers || typeof headers !== "object") throw new Error("WaveSpeed returned an invalid upload ticket")
  const response = await fetch(uploadURL, { method: "PUT", headers, body: bytes, signal })
  if (!response.ok) throw new Error(`WaveSpeed upload returned HTTP ${response.status}`)
  return outputURL
}

async function resolveRefs(refs, base, key, signal) {
  const out = []
  for (const ref of refs) {
    if (ref.kind === "bytes") {
      out.push(await upload(base, key, ref.bytes, ref.name, ref.mime, signal))
      continue
    }
    const value = String(ref.value || "")
    if (value.startsWith("https://")) {
      out.push(value)
      continue
    }
    const parsed = parseDataURI(value)
    if (parsed) {
      out.push(await upload(base, key, parsed.bytes, "reference", parsed.mime, signal))
      continue
    }
    if (value.startsWith("http://")) throw Object.assign(new Error("WaveSpeed requires HTTPS reference URLs"), { status: 400 })
    const file = path.resolve(value)
    if (!fs.existsSync(file)) throw Object.assign(new Error("reference image file does not exist"), { status: 400 })
    const bytes = new Uint8Array(fs.readFileSync(file))
    out.push(await upload(base, key, bytes, path.basename(file), mimeOf(file), signal))
  }
  return out
}

async function resolveImage(value, base, key, signal) {
  if (value == null || value === "") return ""
  const text = String(value)
  if (text.startsWith("https://")) return text
  const parsed = parseDataURI(text)
  if (parsed) return upload(base, key, parsed.bytes, "mask", parsed.mime, signal)
  if (text.startsWith("http://")) throw Object.assign(new Error("WaveSpeed requires HTTPS image URLs"), { status: 400 })
  const file = path.resolve(text)
  if (!fs.existsSync(file)) throw Object.assign(new Error("image file does not exist"), { status: 400 })
  return upload(base, key, new Uint8Array(fs.readFileSync(file)), path.basename(file), mimeOf(file), signal)
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase()
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif" })[ext] || "application/octet-stream"
}

function buildBody(model, fields, urls, size) {
  const kind = modelKind(model)
  const body = { prompt: String(fields.prompt || "") }
  const aspect = fields.aspect_ratio || fields.aspectRatio || size?.aspect
  if (aspect) body.aspect_ratio = aspect
  const resolution = fields.resolution || fields.image_size || fields.imageSize || size?.tier
  if (resolution) body.resolution = String(resolution).toLowerCase()
  if (fields.output_format) body.output_format = String(fields.output_format).toLowerCase()
  if (fields.enable_prompt_expansion !== undefined) body.enable_prompt_expansion = fields.enable_prompt_expansion === true || fields.enable_prompt_expansion === "true"
  if (kind === "ideogram" && fields.quality) body.quality = fields.quality
  if (kind === "seedream" && fields.background) body.background = fields.background
  if (kind === "ideogram" && urls.length) {
    body.image = urls[0]
    if (urls.length > 1) body.reference_images = urls.slice(1)
    if (fields.mask_url) body.mask_url = fields.mask_url
    if (fields.edit_precision) body.edit_precision = fields.edit_precision
  } else if (urls.length) {
    body.images = urls
  }
  return body
}

function outputURLs(value) {
  const rows = Array.isArray(value.outputs) ? value.outputs : []
  return rows.map((row) => typeof row === "string" ? row : row?.url).filter(Boolean)
}

async function generate({ requestURL, init, key, provider, base }) {
  const request = await readImageRequest(requestURL, init)
  if (!request.path.endsWith("/images/generations") && !request.path.endsWith("/images/edits")) {
    return errorResponse(404, `${provider} serves only /images/generations and /images/edits`)
  }
  if ((init.method || "POST").toUpperCase() !== "POST") return errorResponse(405, "use POST to generate an image")
  const fields = requestFields(request)
  if (fields.n !== undefined && Number(fields.n) !== 1) return errorResponse(400, "WaveSpeed supports one image per request through this plugin")
  if (fields.complexity) return errorResponse(400, "WaveSpeed does not support the Magpie complexity parameter through this plugin")
  const requestedModel = String(fields.model || "").trim()
  if (!MODELS.some(([id]) => id === requestedModel)) return errorResponse(400, `choose one of the ${provider} models`)
  const files = requestFiles(request)
  const refs = imageRefs(fields, files)
  const model = endpointFor(requestedModel, refs.length > 0)
  const capabilities = modelCapabilities(provider, model)
  if (fields.edit_precision && !capabilities.editPrecision) {
    return errorResponse(400, `${provider} model ${model} does not support edit_precision`)
  }
  const { size } = validateImageRequest({ provider, model, fields, files, capabilities,
    sizeMode: "aspect-resolution", requestPath: request.path })
  const urls = await resolveRefs(refs, base, key, init.signal)
  const body = buildBody(model, fields, urls, size)
  const mask = fileByField(files, "mask")
  if (mask) body.mask_url = await resolveImage(dataURI(mask.bytes, mask.mime), base, key, init.signal)
  else if (fields.mask_url || fields.mask) body.mask_url = await resolveImage(fields.mask_url || fields.mask, base, key, init.signal)
  const submitted = await httpJSON(`${base}/api/v3/${model}`, key, { method: "POST", body, signal: init.signal })
  const taskId = submitted.id
  if (!taskId) throw new Error("WaveSpeed returned no prediction id")
  const result = await pollUntil({
    signal: init.signal,
    get: () => httpJSON(`${base}/api/v3/predictions/${encodeURIComponent(taskId)}/result`, key, { signal: init.signal }),
    done: (value) => String(value.status || "").toLowerCase() === "completed",
    failed: (value) => ["failed", "cancelled", "canceled", "timeout", "deleted"].includes(String(value.status || "").toLowerCase())
      ? String(value.error || value.status)
      : "",
  })
  const urlsOut = outputURLs(result)
  if (!urlsOut.length) throw new Error("WaveSpeed completed without an image output")
  const data = []
  for (const url of urlsOut) data.push(await downloadAsBase64(url, {}, init.signal))
  return jsonResponse({ created: Math.floor(Date.now() / 1000), data })
}

export async function WaveSpeedImages(input, options = {}) {
  return provider(input, options)
}

const provider = createOpenAICompatibleImageProvider({
  id: PROVIDER,
  name: "WaveSpeed Images",
  base: BASE,
  models: MODELS,
  generate,
  label: "WaveSpeed API key",
  labelZh: "WaveSpeed API Key",
  placeholder: "wsk_…",
})
