import assert from "node:assert/strict"
import test from "node:test"

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

test("RightImage maps the native Gemini image route to its configured base", async () => {
  const plugin = await RightImageGemini({}, { baseURL: "https://rightimage.test/v1beta" })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "rightimage-key" }))
  let sent
  const restore = stubFetch(async (url, init) => {
    sent = { url: String(url), headers: new Headers(init.headers) }
    return Response.json({ candidates: [] })
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
