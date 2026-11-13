import { RightImageGemini as rightImage } from "./providers/rightimage.mjs"
import { TwelveAIImages as twelveAI } from "./providers/twelveai.mjs"
import { WaveSpeedImages as waveSpeed } from "./providers/wavespeed.mjs"

export function RightImageGemini(input, options = {}) {
  return options.onlyProvider && options.onlyProvider !== "image-models/rightimage" ? {} : rightImage(input, options)
}

export function TwelveAIImages(input, options = {}) {
  return options.onlyProvider && options.onlyProvider !== "image-models/twelveai" ? {} : twelveAI(input, options)
}

export function WaveSpeedImages(input, options = {}) {
  return options.onlyProvider && options.onlyProvider !== "image-models/wavespeed" ? {} : waveSpeed(input, options)
}
