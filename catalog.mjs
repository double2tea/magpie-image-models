import { readFileSync } from "node:fs"

export const CATALOG = JSON.parse(
  readFileSync(new URL("./catalog.json", import.meta.url), "utf8"),
)

export function modelEntries(providerId) {
  const provider = CATALOG.providers[providerId]
  if (!provider) throw new Error(`unknown image provider: ${providerId}`)
  return Object.values(provider.models).map((model) => [model.id, model.name])
}

export function modelCapabilities(providerId, modelId) {
  const model = CATALOG.providers[providerId]?.models?.[modelId]
  if (!model) throw Object.assign(new Error(`unknown model for ${providerId}: ${modelId}`), { status: 400 })
  return model.capabilities
}
