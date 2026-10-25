import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@opencode-ai/core/catalog"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderPlugins } from "@opencode-ai/core/plugin/provider"
import { NousPlugin } from "@opencode-ai/core/plugin/provider/nous"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = ProviderV2.ID.make("nous")
const proxyURL = "http://127.0.0.1:8645/v1"

const addPlugin = Effect.fn(function* (http: HttpClient.HttpClient) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* NousPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
})

describe("NousPlugin", () => {
  it.effect("discovers models through the local Hermes subscription proxy", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [
                { id: "model-a", name: "Model A" },
                { id: "hermes-4-405b", name: "Hermes 4" },
                { name: "invalid" },
              ],
            }),
          )
        }),
      )

      yield* addPlugin(http)

      expect(ProviderPlugins.map((item) => item.id)).toContain("nous")
      expect(requests.map((request) => request.url)).toEqual([`${proxyURL}/models`])
      // The transport redacts auth header values at the boundary; presence of
      // the authorization header proves the bearer token was attached.
      expect(JSON.stringify(requests[0]?.headers)).toContain("authorization")

      const provider = yield* catalog.provider.get(providerID)
      expect(provider?.name).toBe("Nous Research via Hermes")
      expect(provider?.api).toMatchObject({
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: proxyURL, apiKey: "unused-hermes-proxy-key" },
      })

      expect(yield* catalog.model.get(providerID, ModelV2.ID.make("model-a"))).toMatchObject({
        name: "Model A",
        enabled: true,
      })
      // Hermes-branded entries and malformed records are excluded, matching the
      // provider's historical model set.
      expect(yield* catalog.model.get(providerID, ModelV2.ID.make("hermes-4-405b"))).toBeUndefined()
      expect(yield* catalog.model.get(providerID, ModelV2.ID.make("invalid"))).toBeUndefined()
    }),
  )
})
