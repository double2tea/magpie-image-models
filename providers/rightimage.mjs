const PROVIDER = "image-models/rightimage"
const MODEL = "gemini-nano-banana-2.1"
const DEFAULT_BASE = "https://api.site/v1beta"

const text = {
  en: "Right Code API key (rightapi.io)",
  zh: "Right Code API Key（rightapi.io）",
}

function upstreamURL(requestURL, base, provider) {
  const url = new URL(requestURL)
  const basePath = new URL(base).pathname.replace(/\/+$/, "")
  const prefix = "/models/" + MODEL
  const marker = basePath + prefix + ":"
  if (!url.pathname.startsWith(marker)) {
    throw new Error(`${provider} serves only ${MODEL}`)
  }
  const method = url.pathname.slice(marker.length)
  if (method !== "generateContent" && method !== "streamGenerateContent") {
    throw new Error(`${provider} does not serve ${method}`)
  }
  return new URL(base.replace(/\/+$/, "") + "/models/" + MODEL + ":generateContent")
}

function sse(data) {
  return new Response(`data: ${JSON.stringify(data)}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  })
}

export async function RightImageGemini(input, options = {}) {
  return RightImageProvider(input, options, PROVIDER)
}

async function RightImageProvider(input, options, provider) {
  const base = typeof options.baseURL === "string" && options.baseURL ? options.baseURL : DEFAULT_BASE
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[provider] = {
        name: "Right Code · Gemini",
        npm: "@ai-sdk/google",
        api: base,
        models: {
          [MODEL]: {
            name: "Nano Banana 2.1",
            modalities: { input: ["text", "image"], output: ["text", "image"] },
            limit: { context: 65536, output: 32768 },
          },
        },
      }
    },
    auth: {
      provider,
      methods: [
        {
          type: "api",
          label: text.en,
          labels: { zh: text.zh },
          placeholder: "sk-…",
        },
      ],
      loader: async (getAuth) => ({
        baseURL: base,
        fetch: async (requestURL, init = {}) => {
          const auth = await getAuth()
          if (auth?.type !== "api" || !auth.key) throw new Error("Right Code Gemini is not signed in")
          const headers = new Headers(init.headers)
          headers.delete("x-goog-api-key")
          headers.set("authorization", "Bearer " + auth.key)
          headers.set("content-type", "application/json")
          headers.set("accept", "application/json")
          headers.set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36")
          const response = await fetch(upstreamURL(String(requestURL), base, provider), {
            ...init,
            headers,
          })
          if (!response.ok || !String(requestURL).includes(":streamGenerateContent")) return response
          const body = await response.json()
          return sse(body)
        },
      }),
    },
  }
}
