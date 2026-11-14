import { CATALOG } from "../catalog.mjs"
import {
  createOpenAICompatibleImageProvider, dataURI, downloadAsBase64, errorResponse,
  fetchBytes, imageRefs, jsonResponse, parseDataURI, pollUntil, readImageRequest,
  requestFields, requestFiles, validateImageRequest,
} from "../common.mjs"

const providerID = "image-models/rightimage"

async function generate({ requestURL, init, key, base, definitions }) {
  const root = base.replace(/\/v1(?:beta)?\/?$/, "").replace(/\/+$/, "")
  const pathname = new URL(requestURL).pathname
  const native = pathname.match(/\/models\/([^/:]+):(generateContent|streamGenerateContent)$/)
  let model
  let body
  let endpoint
  let definition
  if (native) {
    model = decodeURIComponent(native[1])
    definition = definitions[model]
    if (definition?.mode !== "gemini") return errorResponse(400, "Choose a configured Gemini image model")
    body = { ...JSON.parse(init.body), async: true }
    const references = (body.contents ?? []).flatMap((content) => content.parts ?? [])
      .filter((part) => part.inline_data || part.inlineData || part.file_data || part.fileData)
    if (references.length && !definition.capabilities.edit) return errorResponse(400, "Model does not support reference editing")
    if (definition.capabilities.maxReferences != null && references.length > definition.capabilities.maxReferences) {
      return errorResponse(400, `Model accepts at most ${definition.capabilities.maxReferences} reference images`)
    }
    endpoint = `/v1beta/models/${encodeURIComponent(model)}:generateContent`
  } else {
    const request = await readImageRequest(requestURL, init)
    if (!["/v1/images/generations", "/v1/images/edits"].includes(request.path)) {
      return errorResponse(404, "Use /v1/images/generations or /v1/images/edits")
    }
    const fields = requestFields(request)
    if (fields.complexity) return errorResponse(400, "Right Code complexity support is not verified through this plugin")
    const files = requestFiles(request)
    model = String(fields.model || "")
    definition = definitions[model]
    const capabilities = definition?.capabilities
    const { size } = validateImageRequest({ provider: providerID, model, fields, files, capabilities,
      sizeMode: definition?.mode === "gemini" ? "aspect-resolution" : "pixels", requestPath: request.path })
    const references = imageRefs(fields, files)
    if (fields.n !== undefined && (!Number.isInteger(Number(fields.n)) || Number(fields.n) < 1)) {
      return errorResponse(400, "n must be a positive integer")
    }
    if (definition.mode === "gemini") {
      if (fields.n !== undefined && Number(fields.n) !== 1) return errorResponse(400, "Right Code Gemini supports one image per request through this plugin")
      const parts = [{ text: fields.prompt }]
      for (const reference of references) {
        const image = reference.kind === "bytes" ? reference :
          reference.value.startsWith("data:") ? parseDataURI(reference.value) :
            await fetchBytes(reference.value, {}, init.signal)
        if (!image || !image.mime.startsWith("image/")) return errorResponse(400, "Invalid reference image")
        parts.push({ inline_data: { mime_type: image.mime, data: Buffer.from(image.bytes).toString("base64") } })
      }
      body = { async: true, contents: [{ role: "user", parts }] }
      const aspectRatio = fields.aspect_ratio || fields.aspectRatio || size?.aspect
      const imageSize = fields.resolution || fields.image_size || fields.imageSize || size?.tier
      if (aspectRatio || imageSize) body.generationConfig = { imageConfig: { aspectRatio, imageSize } }
      endpoint = `/v1beta/models/${encodeURIComponent(model)}:generateContent`
    } else {
      body = { model, prompt: fields.prompt, async: true, n: Number(fields.n ?? 1) }
      for (const field of ["size", "quality", "background", "output_format"]) {
        if (fields[field]) body[field] = fields[field]
      }
      if (size?.width) body.size = `${size.width}x${size.height}`
      if (fields.output_format) body.output_format = String(fields.output_format).toLowerCase()
      if (references.length) body.images = references.map((reference) =>
        reference.kind === "bytes" ? dataURI(reference.bytes, reference.mime) : reference.value)
      endpoint = references.length ? "/v1/images/edits" : "/v1/images/generations"
    }
  }
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" }
  const submitted = await fetch(root + endpoint, {
    method: "POST", headers, body: JSON.stringify(body), signal: init.signal,
  })
  if (!submitted.ok) return submitted
  const task = await submitted.json()
  if (typeof task.task_id !== "string" || !task.task_id) throw new Error("Right Code returned no task ID")
  const result = await pollUntil({
    signal: init.signal,
    get: async () => {
      const response = await fetch(`${root}/v1/tasks/${encodeURIComponent(task.task_id)}`, { headers, signal: init.signal })
      if (!response.ok) throw new Error(`Right Code task query returned HTTP ${response.status}`)
      return response.json()
    },
    done: (value) => Array.isArray(value.data) || Array.isArray(value.candidates),
    failed: (value) => value.error || ["failed", "expired", "canceled", "cancelled"].includes(value.status)
      ? value.error?.message || value.message || "Right Code generation failed" : "",
  })
  const data = []
  if (definition.mode === "gemini") {
    for (const candidate of result.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text !== "string" || !/^https?:\/\/\S+$/.test(part.text.trim())) continue
        const image = await downloadAsBase64(part.text.trim(), {}, init.signal)
        data.push(image)
        delete part.text
        part.inlineData = { mimeType: image.media_type, data: image.b64_json }
      }
    }
  } else {
    for (const image of result.data ?? []) {
      if (typeof image.url !== "string") throw new Error("Right Code returned an invalid image URL")
      data.push(await downloadAsBase64(image.url, {}, init.signal))
    }
  }
  if (!data.length) throw new Error("Right Code completed without an image")
  if (native?.[2] === "streamGenerateContent") {
    return new Response(`data: ${JSON.stringify(result)}\n\n`, { headers: { "content-type": "text/event-stream" } })
  }
  return jsonResponse(native ? result : { created: Math.floor(Date.now() / 1000), data })
}

export async function RightImageGemini(input, options = {}) {
  if (options.models !== undefined && (!options.models || typeof options.models !== "object" || Array.isArray(options.models))) {
    throw new Error("models must map model IDs to protocol and capability definitions")
  }
  const defaults = CATALOG.providers[providerID].models
  const definitions = {}
  for (const id of new Set([...Object.keys(defaults), ...Object.keys(options.models ?? {})])) {
    const custom = options.models?.[id]
    if (custom !== undefined && (!custom || typeof custom !== "object" || Array.isArray(custom))) {
      throw new Error(`Invalid image model definition: ${id}`)
    }
    const definition = { ...defaults[id], ...custom,
      capabilities: { ...defaults[id]?.capabilities, ...custom?.capabilities } }
    if (!id || /[\s\u0000-\u001f]/.test(id) || !["gemini", "openai"].includes(definition.mode) ||
        typeof definition.name !== "string" || !definition.name.trim() ||
        typeof definition.capabilities.generate !== "boolean" || typeof definition.capabilities.edit !== "boolean" ||
        (definition.capabilities.maxReferences != null && (!Number.isInteger(definition.capabilities.maxReferences) ||
          definition.capabilities.maxReferences < 0))) {
      throw new Error(`Invalid image model definition: ${id}`)
    }
    definitions[id] = definition
  }
  const provider = createOpenAICompatibleImageProvider({
    id: providerID, name: "Right Code Images", base: "https://api.site/v1",
    models: Object.entries(definitions).map(([id, model]) => [id, model.name, model.capabilities,
      { size: model.mode === "gemini" ? "aspect-resolution" : "pixels" }]),
    generate: (request) => generate({ ...request, definitions }),
    label: "Right Code API key (rightapi.io)", labelZh: "Right Code API Key（rightapi.io）", placeholder: "sk-…",
  })
  return provider(input, options)
}
