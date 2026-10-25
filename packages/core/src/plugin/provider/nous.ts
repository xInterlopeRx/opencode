import { Duration, Effect, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { define } from "../internal"

// The Nous provider is a thin OpenAI-compatible client against the local Hermes
// subscription proxy. Hermes owns the portal credential lifecycle; OpenCode only
// discovers models through the proxy and never handles portal tokens itself.
const providerID = ProviderV2.ID.make("nous")
const defaultProxyURL = "http://127.0.0.1:8645/v1"
const proxyAPIKey = "unused-hermes-proxy-key"
const RemoteModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
})
const ProxyResponse = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
const decodeModel = Schema.decodeUnknownOption(RemoteModel)

export const NousPlugin = define({
  id: "nous",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const baseURL = (process.env.OPENCODE_HERMES_PROXY_URL || defaultProxyURL).replace(/\/+$/, "")

    const load = Effect.fn("NousPlugin.load")(function* () {
      return yield* http
        .execute(
          HttpClientRequest.get(`${baseURL}/models`).pipe(
            HttpClientRequest.bearerToken(proxyAPIKey),
            HttpClientRequest.acceptJson,
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ProxyResponse)),
          Effect.map((body) =>
            body.data.flatMap((raw) => {
              const model = Option.getOrUndefined(decodeModel(raw))
              if (!model || model.id.toLowerCase().includes("hermes")) return []
              return [{ id: model.id, name: model.name }]
            }),
          ),
          Effect.timeout(Duration.millis(10_000)),
          Effect.catch((cause) =>
            Effect.logWarning("Hermes Nous proxy model discovery failed", {
              causeType: cause instanceof Error ? cause.name : typeof cause,
            }).pipe(Effect.as([] as { id: string; name?: string }[])),
          ),
        )
    })

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const models = yield* load()
        catalog.provider.update(providerID, (provider) => {
          provider.name = "Nous Research via Hermes"
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            settings: { baseURL, apiKey: proxyAPIKey },
          }
          // A body apiKey marks the provider as available without portal credentials;
          // the proxy attaches the real Hermes-managed credential itself.
          provider.request.body.apiKey = proxyAPIKey
        })
        const seen = new Set(models.map((model) => model.id))
        for (const id of catalog.provider.get(providerID)?.models.keys() ?? []) {
          if (!seen.has(id)) catalog.model.remove(providerID, id)
        }
        for (const model of models) {
          catalog.model.update(providerID, ModelV2.ID.make(model.id), (draft) => {
            draft.name = model.name ?? model.id
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            draft.status = "active"
            draft.enabled = true
            draft.limit = { context: 131_072, output: 16_384 }
            draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
          })
        }
      }),
    )
    // Registration above already materializes the catalog once: State.transform
    // reloads immediately outside a batch, and plugin boot batches and flushes
    // in production. Then refresh roughly hourly with random jitter so proxy
    // traffic does not look like automated polling of the upstream Nous servers.
    const delay = Duration.millis(60 * 60 * 1_000 + Math.random() * 15 * 60 * 1_000)
    yield* Effect.sleep(delay).pipe(
      Effect.andThen(ctx.catalog.reload()),
      Effect.repeat(Schedule.spaced(Duration.millis(60 * 60 * 1_000))),
      Effect.forkScoped,
    )
  }),
})
