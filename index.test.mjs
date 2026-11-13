import assert from "node:assert/strict"
import test from "node:test"

import { CATALOG, modelCapabilities } from "./catalog.mjs"
import { RightImageGemini, TwelveAIImages, WaveSpeedImages } from "./index.mjs"

function jsonRequest(url, body) {
  return [url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }]
}

function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => { globalThis.fetch = original }
}

test("publishes three independent providers from one package", async () => {
  const cfg = { provider: {} }
  for (const factory of [RightImageGemini, TwelveAIImages, WaveSpeedImages]) {
    const plugin = await factory({}, {})
    await plugin.config(cfg)
  }
  assert.deepEqual(Object.keys(cfg.provider).sort(), [
    "image-models/rightimage",
    "image-models/twelveai",
    "image-models/wavespeed",
  ])
  assert.ok(cfg.provider["image-models/rightimage"].models["gemini-nano-banana-2.1"])
  assert.ok(cfg.provider["image-models/twelveai"].models["gpt-image-2.6-flare"])
  assert.ok(cfg.provider["image-models/wavespeed"].models["minimax/h3-image/text-to-image"])
})

test("onlyProvider enables one existing account without activating other provider accounts", async () => {
  const cfg = {}
  for (const factory of [RightImageGemini, TwelveAIImages, WaveSpeedImages]) {
    const plugin = await factory({}, { onlyProvider: "image-models/rightimage" })
    if (plugin.config) await plugin.config(cfg)
  }
  assert.deepEqual(Object.keys(cfg.provider), ["image-models/rightimage"])
})

test("provider catalogs and capabilities come from the machine-readable catalog", async () => {
  const cfg = { provider: {} }
  for (const factory of [RightImageGemini, TwelveAIImages, WaveSpeedImages]) {
    const plugin = await factory({}, {})
    await plugin.config(cfg)
  }
  for (const [providerId, provider] of Object.entries(CATALOG.providers)) {
    assert.deepEqual(
      Object.keys(cfg.provider[providerId].models).sort(),
      Object.keys(provider.models).sort(),
    )
    for (const [modelId, model] of Object.entries(provider.models)) {
      assert.deepEqual(cfg.provider[providerId].models[modelId].capabilities, model.capabilities)
    }
  }
})

test("each provider exposes its standard API-key login without machine-specific setup", async () => {
  for (const [factory, provider] of [
    [RightImageGemini, "image-models/rightimage"],
    [TwelveAIImages, "image-models/twelveai"],
    [WaveSpeedImages, "image-models/wavespeed"],
  ]) {
    const plugin = await factory({}, {})
    assert.equal(plugin.auth.provider, provider)
    assert.equal(plugin.auth.methods[0].type, "api")
    assert.equal(plugin.auth.methods[0].authorize, undefined)
    assert.equal(plugin.auth.methods[0].keyless, undefined)
    assert.match(plugin.auth.methods[0].placeholder, /^(sk-|wsk_)/)
  }
})

test("a missing sign-in fails closed before a provider request", async () => {
  for (const factory of [TwelveAIImages, WaveSpeedImages]) {
    const plugin = await factory({}, {})
    const loader = await plugin.auth.loader(async () => undefined)
    const response = await loader.fetch("plugin://image-models/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "not-used", prompt: "test" }),
    })
    assert.equal(response.status, 401)
  }
})

test("unknown capability null is not treated as a rejection", async () => {
  const capabilities = modelCapabilities("image-models/twelveai", "gemini-3.1-flash-image")
  assert.equal(capabilities.maxReferences, null)
  const plugin = await TwelveAIImages({}, { baseURL: "https://twelve.test" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "twelve-key" }))
  const restore = stubFetch(async (url) => {
    if (String(url).endsWith("/v1/task/submit")) return Response.json({ id: "task-unknown" })
    if (String(url).endsWith("/v1/task/task-unknown")) {
      return Response.json({ status: "completed", outputs: ["https://cdn.test/result.png"] })
    }
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "content-type": "image/png" },
    })
  })
  try {
    const response = await loader.fetch(
      "plugin://image-models/v1/images/generations",
      jsonRequest("", {
        model: "gemini-3.1-flash-image",
        prompt: "coastal still life",
        images: Array.from({ length: 15 }, (_, i) => `https://cdn.test/${i}.png`),
      })[1],
    )
    assert.equal(response.status, 200)
  } finally {
    restore()
  }
})

test("RightImage maps the native Gemini image route to its configured base", async () => {
  const plugin = await RightImageGemini({}, { baseURL: "https://rightimage.test/v1beta" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "rightimage-key" }))
  let sent
  const restore = stubFetch(async (url, init) => {
    if (String(url).endsWith(":generateContent")) {
      sent = { url: String(url), headers: new Headers(init.headers) }
      assert.equal(JSON.parse(init.body).async, true)
      return Response.json({ task_id: "gemini-task" })
    }
    if (String(url).endsWith("/v1/tasks/gemini-task")) return Response.json({
      candidates: [{ content: { parts: [{ text: "https://cdn.test/gemini.png" }] } }],
    })
    assert.equal(new Headers(init.headers).get("authorization"), null)
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } })
  })
  try {
    const response = await loader.fetch(
      "plugin://image-models/v1beta/models/gemini-nano-banana-2.1:generateContent",
      jsonRequest("", { contents: [] })[1],
    )
    assert.equal(response.status, 200)
    assert.equal(sent.url, "https://rightimage.test/v1beta/models/gemini-nano-banana-2.1:generateContent")
    assert.equal(sent.headers.get("authorization"), "Bearer rightimage-key")
    assert.equal(sent.headers.get("x-goog-api-key"), null)
  } finally {
    restore()
  }
})

test("Right Code keeps four JSON and multipart reference images through asynchronous generation", async () => {
  const plugin = await RightImageGemini({}, { baseURL: "https://rightimage.test/v1" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "fixture" }))
  for (const model of ["gemini-nano-banana-2.1", "gpt-image-2.6-flare"]) {
    for (const multipart of [false, true]) {
      const reference = "data:image/png;base64,iVBORw=="
      const form = new FormData()
      form.set("model", model)
      form.set("prompt", "four reference fixture")
      for (let index = 0; index < 4; index++) form.append("image[]", new Blob([Buffer.from("iVBORw==", "base64")], { type: "image/png" }), `${index}.png`)
      const restore = stubFetch(async (url, init) => {
        if (String(url).endsWith("/v1/tasks/task")) {
          return Response.json(model.startsWith("gemini") ?
            { candidates: [{ content: { parts: [{ text: "https://cdn.test/out.png" }] } }] } :
            { data: [{ url: "https://cdn.test/out.png" }] })
        }
        if (String(url).startsWith("https://cdn.test")) {
          assert.equal(new Headers(init.headers).get("authorization"), null)
          return new Response(Buffer.from("iVBORw==", "base64"), { headers: { "content-type": "image/png" } })
        }
        const body = JSON.parse(init.body)
        assert.equal(body.async, true)
        if (model.startsWith("gemini")) {
          assert.ok(String(url).endsWith(":generateContent"))
          assert.deepEqual(body.contents[0].parts.slice(1), Array(4).fill({ inline_data: { mime_type: "image/png", data: "iVBORw==" } }))
        } else {
          assert.ok(String(url).endsWith("/images/edits"))
          assert.deepEqual(body.images, Array(4).fill(reference))
        }
        return Response.json({ task_id: "task" })
      })
      try {
        const response = await loader.fetch("https://rightimage.test/v1/images/edits", multipart ?
          { method: "POST", body: form } : jsonRequest("", { model, prompt: "four reference fixture",
            images: Array(4).fill({ image_url: reference }) })[1])
        assert.equal(response.status, 200)
        assert.equal((await response.json()).data.length, 1)
      } finally { restore() }
    }
  }
})

test("configured new model IDs choose protocols by metadata and enforce their own reference limits", async () => {
  for (const mode of ["gemini", "openai"]) {
    const model = `future-${mode}-model`
    const plugin = await RightImageGemini({}, { baseURL: "https://custom-host.test/v1", models: {
      [model]: { name: "Future image", mode,
        capabilities: { generate: true, edit: true, maxReferences: 6 } },
    } })
    const cfg = {}
    await plugin.config(cfg)
    assert.equal(cfg.provider["image-models/rightimage"].models[model].capabilities.maxReferences, 6)
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: "fixture" }))
    const reference = "data:image/png;base64,iVBORw=="
    let submits = 0
    const restore = stubFetch(async (url, init) => {
      if (String(url).endsWith("/v1/tasks/future")) {
        return Response.json(mode === "gemini"
          ? { candidates: [{ content: { parts: [{ text: "https://cdn.test/result.png" }] } }] }
          : { data: [{ url: "https://cdn.test/result.png" }] })
      }
      if (String(url).startsWith("https://cdn.test")) {
        return new Response(Buffer.from("iVBORw==", "base64"), { headers: { "content-type": "image/png" } })
      }
      submits++
      const body = JSON.parse(init.body)
      if (mode === "gemini") {
        assert.equal(String(url), `https://custom-host.test/v1beta/models/${model}:generateContent`)
        assert.equal(body.contents[0].parts.length, 7)
      } else {
        assert.equal(String(url), "https://custom-host.test/v1/images/edits")
        assert.deepEqual(body.images, Array(6).fill(reference))
      }
      return Response.json({ task_id: "future" })
    })
    try {
      const send = (count) => loader.fetch("plugin://images/v1/images/edits", jsonRequest("", {
        model, prompt: "fixture", images: Array(count).fill({ image_url: { url: reference } }),
      })[1])
      assert.equal((await send(6)).status, 200)
      assert.equal((await send(7)).status, 400)
      assert.equal(submits, 1)
    } finally { restore() }
  }
  await assert.rejects(RightImageGemini({}, { models: { unknown: { name: "Missing protocol" } } }), /Invalid image model/)
})

test("12ai submits, polls and downloads through the ordinary image route", async () => {
  const plugin = await TwelveAIImages({}, { baseURL: "https://twelve.test" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "twelve-key" }))
  const calls = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === "https://twelve.test/v1/task/submit") {
      const body = JSON.parse(init.body)
      assert.equal(body.model, "gpt-image-2.6-flare")
      assert.equal(body.input.n, 1)
      return Response.json({ id: "task-1" })
    }
    if (String(url) === "https://twelve.test/v1/task/task-1") {
      return Response.json({ status: "completed", outputs: ["https://cdn.test/result.png"] })
    }
    if (String(url) === "https://cdn.test/result.png") {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      })
    }
    throw new Error(`unexpected request ${url}`)
  })
  try {
    const response = await loader.fetch(
      "plugin://image-models/v1/images/generations",
      jsonRequest("", {
        model: "gpt-image-2.6-flare",
        prompt: "coastal still life",
        size: "1536x1024",
        n: "1",
      })[1],
    )
    const value = await response.json()
    assert.equal(response.status, 200)
    assert.equal(value.data.length, 1)
    assert.equal(value.data[0].media_type, "image/png")
    assert.equal(Buffer.from(value.data[0].b64_json, "base64").length, 4)
    assert.equal(calls.length, 3)
  } finally {
    restore()
  }
})

test("12ai rejects masks for Gemini models and reference counts above the known limit", async () => {
  const plugin = await TwelveAIImages({}, { baseURL: "https://twelve.test" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "twelve-key" }))
  const restore = stubFetch(async () => {
    throw new Error("provider must not be called for invalid requests")
  })
  try {
    const masked = new FormData()
    masked.set("model", "gemini-nano-banana-2.1")
    masked.set("prompt", "edit the scene")
    masked.set("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "source.png")
    masked.set("mask", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "mask.png")
    const maskResponse = await loader.fetch("plugin://image-models/v1/images/edits", {
      method: "POST",
      body: masked,
    })
    assert.equal(maskResponse.status, 400)
    assert.match((await maskResponse.json()).error.message, /does not support mask/)

    const tooMany = await loader.fetch(
      "plugin://image-models/v1/images/generations",
      jsonRequest("", {
        model: "gemini-nano-banana-2.1",
        prompt: "compose the references",
        images: Array.from({ length: 15 }, (_, i) => `https://cdn.test/${i}.png`),
      })[1],
    )
    assert.equal(tooMany.status, 400)
    assert.match((await tooMany.json()).error.message, /at most 14/)
  } finally {
    restore()
  }
})

test("12ai validates output formats, GIF controls and markup boundaries", async () => {
  const plugin = await TwelveAIImages({}, { baseURL: "https://twelve.test" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "twelve-key" }))
  const restore = stubFetch(async () => {
    throw new Error("provider must not be called for invalid requests")
  })
  try {
    const cases = [
      [{ model: "gpt-image-2.6-flare", prompt: "test", output_format: "svg" }, /output_format/],
      [{ model: "gpt-image-2.6-flare", prompt: "test", frame_count: "4" }, /require GIF/],
      [{ model: "gpt-image-2.6-flare", prompt: "test", output_format: "gif", frame_count: "17" }, /frame_count/],
      [{ model: "gpt-image-2.6-flare", prompt: "test", markup: "https://cdn.test/markup.png" }, /requires a reference/],
    ]
    for (const [body, pattern] of cases) {
      const response = await loader.fetch(
        "plugin://image-models/v1/images/generations",
        jsonRequest("", body)[1],
      )
      assert.equal(response.status, 400)
      assert.match((await response.json()).error.message, pattern)
    }
  } finally {
    restore()
  }
})

test("WaveSpeed uploads a reference, selects the edit endpoint and downloads the result", async () => {
  const plugin = await WaveSpeedImages({}, { baseURL: "https://wavespeed.test" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "wavespeed-key" }))
  const calls = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === "https://wavespeed.test/api/v3/media/uploads") {
      return Response.json({
        data: {
          upload: { url: "https://storage.test/upload", headers: { "x-upload": "ticket" } },
          download_url: "https://storage.test/reference.png",
        },
      })
    }
    if (String(url) === "https://storage.test/upload") {
      return new Response(null, { status: 200 })
    }
    if (String(url) === "https://wavespeed.test/api/v3/bytedance/seedream-v5.5/edit") {
      const body = JSON.parse(init.body)
      assert.deepEqual(body.images, ["https://storage.test/reference.png"])
      return Response.json({ data: { id: "prediction-1" } })
    }
    if (String(url) === "https://wavespeed.test/api/v3/predictions/prediction-1/result") {
      return Response.json({
        data: { status: "completed", outputs: ["https://cdn.test/edited.jpg"] },
      })
    }
    if (String(url) === "https://cdn.test/edited.jpg") {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      })
    }
    throw new Error(`unexpected request ${url}`)
  })
  try {
    const form = new FormData()
    form.set("model", "bytedance/seedream-v5.5")
    form.set("prompt", "change the paint to green")
    form.set("size", "2048x1152")
    form.set("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "reference.png")
    const response = await loader.fetch("plugin://image-models/v1/images/edits", {
      method: "POST",
      body: form,
    })
    const value = await response.json()
    assert.equal(response.status, 200)
    assert.equal(value.data[0].media_type, "image/jpeg")
    assert.equal(Buffer.from(value.data[0].b64_json, "base64").length, 3)
    assert.equal(calls.length, 5)
  } finally {
    restore()
  }
})

test("WaveSpeed rejects unsupported tiers and edit-only calls without references", async () => {
  const plugin = await WaveSpeedImages({}, { baseURL: "https://wavespeed.test" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "wavespeed-key" }))
  const restore = stubFetch(async () => {
    throw new Error("provider must not be called for invalid requests")
  })
  try {
    const cases = [
      [{
        model: "bytedance/seedream-v5.5",
        prompt: "test",
        resolution: "4K",
      }, /supports resolutions/],
      [{
        model: "bytedance/seedream-v5.5/edit",
        prompt: "test",
      }, /edit-only/],
      [{
        model: "minimax/h3-image/text-to-image",
        prompt: "test",
        output_format: "gif",
      }, /output_format/],
    ]
    for (const [body, pattern] of cases) {
      const response = await loader.fetch(
        "plugin://image-models/v1/images/generations",
        jsonRequest("", body)[1],
      )
      assert.equal(response.status, 400)
      assert.match((await response.json()).error.message, pattern)
    }
  } finally {
    restore()
  }
})

test("WaveSpeed forwards prompt expansion and enforces Ideogram mask constraints", async () => {
  const plugin = await WaveSpeedImages({}, { baseURL: "https://wavespeed.test" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "wavespeed-key" }))
  const calls = []
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/api/v3/media/uploads")) {
      return Response.json({
        data: {
          upload: { url: "https://storage.test/upload", headers: { "x-upload": "ticket" } },
          download_url: "https://storage.test/uploaded.png",
        },
      })
    }
    if (String(url) === "https://storage.test/upload") return new Response(null)
    if (String(url).endsWith("/api/v3/ideogram-ai/ideogram-v4.5/edit")) {
      const body = JSON.parse(init.body)
      assert.equal(body.image, "https://storage.test/uploaded.png")
      assert.equal(body.mask_url, "https://storage.test/uploaded.png")
      assert.equal(body.aspect_ratio, undefined)
      return Response.json({ data: { id: "prediction-ideogram" } })
    }
    if (String(url).endsWith("/api/v3/predictions/prediction-ideogram/result")) {
      return Response.json({ data: { status: "completed", outputs: ["https://cdn.test/result.png"] } })
    }
    if (String(url) === "https://cdn.test/result.png") {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      })
    }
    throw new Error(`unexpected request ${url}`)
  })
  try {
    const form = new FormData()
    form.set("model", "ideogram-ai/ideogram-v4.5")
    form.set("prompt", "replace only the chair")
    form.set("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "source.png")
    form.set("mask", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "mask.png")
    const response = await loader.fetch("plugin://image-models/v1/images/edits", {
      method: "POST",
      body: form,
    })
    assert.equal(response.status, 200)
    assert.ok(calls.some((call) => String(call.url).endsWith("/api/v3/ideogram-ai/ideogram-v4.5/edit")))

    const invalid = await loader.fetch(
      "plugin://image-models/v1/images/generations",
      jsonRequest("", {
        model: "ideogram-ai/ideogram-v4.5",
        prompt: "replace only the chair",
        image: "https://cdn.test/source.png",
        mask_url: "https://cdn.test/mask.png",
        aspect_ratio: "16:9",
      })[1],
    )
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).error.message, /omitting aspect_ratio/)
  } finally {
    restore()
  }
})
