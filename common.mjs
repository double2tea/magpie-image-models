const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"])

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export function errorResponse(status, message) {
  return jsonResponse({
    error: {
      message: String(message || "image request failed"),
      type: status >= 500 ? "api_error" : "invalid_request_error",
    },
  }, status)
}

export function safeMessage(error, secret = "") {
  let message = String(error?.message ?? error ?? "image request failed")
  if (secret) message = message.split(secret).join("[redacted]")
  return message.slice(0, 1000)
}

export function parseDataURI(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) return null
  const comma = value.indexOf(",")
  if (comma < 0) return null
  const header = value.slice(5, comma)
  const payload = value.slice(comma + 1)
  const parts = header.split(";")
  const mime = (parts.shift() || "application/octet-stream").toLowerCase()
  if (!parts.includes("base64")) return null
  try {
    const bytes = Buffer.from(payload, "base64")
    return bytes.length ? { bytes: new Uint8Array(bytes), mime } : null
  } catch {
    return null
  }
}

export function dataURI(bytes, mime) {
  return `data:${mime || "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`
}

export function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  return "application/octet-stream"
}

export function normalizeMime(value) {
  const mime = String(value || "").trim().toLowerCase()
  if (mime === "image/jpg") return "image/jpeg"
  return IMAGE_MIMES.has(mime) ? mime : ""
}

async function bytesOf(body) {
  if (body == null || body === "") return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  throw new Error("request body must be JSON or multipart form data")
}

function headerOf(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return headers.get(name) || ""
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] || "" : value || ""
  }
  return ""
}

export async function readImageRequest(requestURL, init = {}) {
  const path = new URL(String(requestURL), "http://magpie.local").pathname
  const headers = new Headers(init.headers || {})
  const contentType = headerOf(headers, "content-type").split(";")[0].trim().toLowerCase()
  let body = init.body
  if (body instanceof FormData) {
    const parsed = await formFiles(body)
    return { path, fields: parsed.fields, files: parsed.files }
  }
  if (contentType === "multipart/form-data") {
    const response = new Response(await bytesOf(body), { headers })
    let form
    try {
      form = await response.formData()
    } catch {
      throw Object.assign(new Error("request body must be multipart form data"), { status: 400 })
    }
    const parsed = await formFiles(form)
    return { path, fields: parsed.fields, files: parsed.files }
  }
  const text = new TextDecoder().decode(await bytesOf(body))
  let fields
  try {
    fields = text.trim() ? JSON.parse(text) : {}
  } catch {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 })
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 })
  }
  return { path, fields, files: [] }
}

async function formFiles(form) {
  const files = []
  const fields = {}
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      if (fields[name] === undefined) fields[name] = value
      continue
    }
    const bytes = new Uint8Array(await value.arrayBuffer())
    files.push({
      field: name,
      name: value.name || "image",
      mime: normalizeMime(value.type) || sniffMime(bytes),
      bytes,
    })
  }
  return { files, fields }
}

export function requestFields(request) {
  return request.fields || {}
}

export function requestFiles(request) {
  return Array.isArray(request.files) ? request.files : []
}

export function imageRefs(fields, files) {
  const refs = []
  for (const file of files) {
    if (["image", "image[]", "images", "reference_images"].includes(file.field)) {
      refs.push({ kind: "bytes", bytes: file.bytes, mime: file.mime, name: file.name })
    }
  }
  for (const key of ["images", "image", "reference_images"]) {
    const value = fields[key]
    if (value == null) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") refs.push({ kind: "value", value: item })
      else if (item && typeof item.url === "string") refs.push({ kind: "value", value: item.url })
    }
  }
  return refs
}

export function maskFile(files) {
  return files.find((file) => file.field === "mask") || null
}

export function sizeInfo(value) {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(value || "").trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return null
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const divisor = gcd(width, height)
  return {
    width,
    height,
    aspect: `${width / divisor}:${height / divisor}`,
    tier: Math.max(width, height) <= 1280 ? "1K" : Math.max(width, height) <= 2560 ? "2K" : "4K",
  }
}

export function resolutionFor(value, allowed, fallback = "") {
  const info = sizeInfo(value)
  let tier = info?.tier || String(value || "").toUpperCase()
  if (tier === "1K" || tier === "2K" || tier === "4K") {
    return allowed.includes(tier) ? tier : allowed[allowed.length - 1] || fallback
  }
  return fallback
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const abort = () => {
        clearTimeout(timer)
        reject(Object.assign(new Error("image request aborted"), { status: 499 }))
      }
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    }
  })
}

export async function pollUntil({ signal, deadline = Date.now() + 9 * 60 * 1000, interval = 2000, get, done, failed }) {
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error("image request aborted"), { status: 499 })
    const value = await get()
    if (done(value)) return value
    const failure = failed?.(value)
    if (failure) throw new Error(failure)
    if (Date.now() >= deadline) throw new Error("image task did not finish before the polling deadline")
    await sleep(interval, signal)
  }
}

export async function fetchBytes(url, headers = {}, signal) {
  const response = await fetch(url, { headers, redirect: "follow", signal })
  if (!response.ok) throw new Error(`image download returned HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const mime = normalizeMime(response.headers.get("content-type")) || sniffMime(bytes)
  return { bytes, mime }
}

export async function downloadAsBase64(url, headers = {}, signal) {
  if (url.startsWith("data:")) {
    const parsed = parseDataURI(url)
    if (!parsed) throw new Error("image result is not a valid data URI")
    return { b64_json: Buffer.from(parsed.bytes).toString("base64"), media_type: parsed.mime }
  }
  const { bytes, mime } = await fetchBytes(url, headers, signal)
  return { b64_json: Buffer.from(bytes).toString("base64"), media_type: mime }
}

export function imageModel(id, name) {
  return {
    name,
    reasoning: false,
    tool_call: false,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["image"] },
    limit: { context: 0, output: 0 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    variants: {},
    provider: { npm: "@ai-sdk/openai-compatible" },
  }
}

export function createOpenAICompatibleImageProvider({
  id,
  name,
  base,
  models,
  generate,
  label,
  labelZh,
  placeholder,
}) {
  if (!id || !name || !base || !Array.isArray(models) || typeof generate !== "function") {
    throw new TypeError("image provider requires id, name, base, models and generate")
  }
  const authLabel = label || `${name} API key`
  const authLabelZh = labelZh || authLabel
  return async function ImageProvider(_input, options = {}) {
    const api = typeof options.baseURL === "string" && options.baseURL ? options.baseURL : base
    const catalog = Object.fromEntries(models.map(([modelId, modelName]) => [modelId, imageModel(modelId, modelName)]))
    return {
      config: async (cfg) => {
        cfg.provider ??= {}
        cfg.provider[id] = {
          name,
          npm: "@ai-sdk/openai-compatible",
          api,
          models: catalog,
        }
      },
      auth: {
        provider: id,
        methods: [{
          type: "api",
          label: authLabel,
          labels: { zh: authLabelZh },
          ...(placeholder ? { placeholder } : {}),
        }],
        loader: async (getAuth) => ({
          baseURL: api,
          fetch: async (requestURL, init = {}) => {
            const auth = await getAuth()
            if (auth?.type !== "api" || !auth.key) return errorResponse(401, `${id} is not signed in`)
            try {
              return await generate({
                requestURL,
                init,
                key: auth.key,
                provider: id,
                base: api,
              })
            } catch (error) {
              return errorResponse(error?.status || 502, safeMessage(error, auth.key))
            }
          },
        }),
      },
    }
  }
}
