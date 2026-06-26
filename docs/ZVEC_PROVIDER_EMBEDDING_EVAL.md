# Zvec Provider Embedding Eval

This eval checks Zvec candidate preselection with real provider embeddings.

It measures two different surfaces:

- raw Zvec candidate hit rate: whether provider embeddings place the expected memory id in the Zvec candidate window.
- final Substrate search hit rate: whether the current Substrate canonical search contract returns that memory after candidate narrowing.

This distinction matters. Zvec is a candidate sidecar, not the truth store and not the final admission policy. SQLite remains the truth store, and Substrate reloads canonical nodes before returning search results.

## Provider Contract

The eval supports two provider contracts:

- `openai`: OpenAI-compatible embeddings endpoints.
- `minimax`: MiniMax native embeddings endpoint.

### OpenAI-Compatible

```text
POST <base-url><endpoint>
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "model": "...",
  "input": ["text one", "text two"]
}
```

The response must contain `data[].embedding` arrays in request order or with `data[].index`.

### MiniMax Native

MiniMax embeddings use a native request shape:

```text
POST <base-url><endpoint>
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "model": "embo-01",
  "type": "db",
  "texts": ["document text one", "document text two"]
}
```

The eval calls MiniMax with `type: "db"` for memory-node vectors and
`type: "query"` for query vectors. The response must contain `vectors[]`.

## Run

```bash
AIONIS_EMBEDDING_API_KEY=... \
AIONIS_EMBEDDING_MODEL=text-embedding-3-small \
npm run check:zvec-provider-embedding -- \
  --base-url https://api.openai.com/v1 \
  --nodes 240 \
  --scopes 4 \
  --queries 20 \
  --candidate-limit 20
```

For another OpenAI-compatible provider:

```bash
AIONIS_EMBEDDING_API_KEY=... \
npm run check:zvec-provider-embedding -- \
  --base-url https://provider.example/v1 \
  --endpoint /embeddings \
  --model provider-embedding-model
```

For Alibaba Cloud DashScope `text-embedding-v4` through the OpenAI-compatible
endpoint:

```bash
AIONIS_EMBEDDING_PROVIDER=openai \
AIONIS_EMBEDDING_API_KEY=... \
AIONIS_EMBEDDING_MODEL=text-embedding-v4 \
npm run check:zvec-provider-embedding -- \
  --base-url https://dashscope.aliyuncs.com/compatible-mode/v1 \
  --endpoint /embeddings \
  --dimensions 1024 \
  --batch-size 10 \
  --nodes 240 \
  --scopes 4 \
  --queries 20 \
  --candidate-limit 40
```

DashScope `text-embedding-v4` accepts small batches on this endpoint, so the
example uses `--batch-size 10`. In the current provider eval, `--candidate-limit
40` is a better first setting than `20` because it lets Zvec act as a semantic
candidate preselector without prematurely excluding lexical matches.

For MiniMax:

```bash
AIONIS_EMBEDDING_PROVIDER=minimax \
AIONIS_EMBEDDING_API_KEY=... \
AIONIS_EMBEDDING_MODEL=embo-01 \
npm run check:zvec-provider-embedding -- \
  --base-url https://api.minimaxi.com/v1 \
  --nodes 240 \
  --scopes 4 \
  --queries 20 \
  --candidate-limit 20
```

The command writes a report under `reports/zvec-provider-embedding-*` unless `--output` is supplied.

## Options

- `--provider <openai|minimax>`: embedding provider contract. Defaults to `AIONIS_EMBEDDING_PROVIDER` or `openai`.
- `--base-url <url>`: provider base URL. Defaults to `AIONIS_EMBEDDING_BASE_URL` or `https://api.openai.com/v1`.
- `--endpoint <path>`: embeddings endpoint. Defaults to `AIONIS_EMBEDDING_ENDPOINT` or `/embeddings`.
- `--model <name>`: embedding model. Defaults to `AIONIS_EMBEDDING_MODEL`.
- `--api-key-var <name>`: environment variable containing the API key. Defaults to `AIONIS_EMBEDDING_API_KEY`.
- `--dimensions <n>`: optional embedding dimensions request parameter.
- `--nodes <n>`: generated Substrate nodes.
- `--scopes <n>`: generated scopes.
- `--queries <n>`: semantic query probes. Current built-in fixture supports up to 24.
- `--batch-size <n>`: provider embedding batch size.
- `--candidate-limit <n>`: Zvec candidate window.
- `--result-limit <n>`: final Substrate search result limit.
- `--keep-store`: keep temporary SQLite and Zvec files for inspection.

## Report Interpretation

Important fields:

- `raw_zvec_candidate_top1_rate`: provider embedding quality at the Zvec candidate layer.
- `raw_zvec_candidate_topk_rate`: whether the expected memory id entered the candidate window.
- `final_substrate_topk_rate`: current end-to-end `searchNodes()` output after canonical Substrate scoring.
- `lexical_substrate_topk_rate`: canonical deterministic search without Zvec.
- `probe_results`: per-query raw candidate rank, final rank, lexical rank, and returned ids for miss analysis.
- `embedding_usage`: provider requests, embedded text count, input character count, provider token count when exposed, and failed request count.
- `zvec_health`: missing, orphan, and stale sidecar diagnostics.

If raw Zvec hit rate is strong but final Substrate hit rate is weaker, the provider embeddings are finding useful candidates but the final canonical scorer is still acting as a lexical/structured gate. That is a search-contract boundary, not a provider failure.

The provider eval is intentionally strict about this distinction. A low final
Substrate hit rate can happen even when provider vectors are valid if the Zvec
candidate window excludes the expected id or if the final canonical scorer
prefers lexical/structured evidence over semantic candidates.

Substrate fuses candidate-index evidence into final `searchNodes()` ranking by
adding auditable `semantic_candidate_fusion` reasons and preserving a small
semantic recall floor for top-ranked candidates. This only changes ranking after
normal scope, lifecycle, authority, confidence, team, agent, and target-file
filters pass. Zvec still remains a sidecar candidate preselector; file/SQLite
stores remain the truth store.
