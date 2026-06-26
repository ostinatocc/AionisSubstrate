# Zvec Provider Embedding Eval

This eval checks Zvec candidate preselection with real provider embeddings.

It measures two different surfaces:

- raw Zvec candidate hit rate: whether provider embeddings place the expected memory id in the Zvec candidate window.
- final Substrate search hit rate: whether the current Substrate canonical search contract returns that memory after candidate narrowing.

This distinction matters. Zvec is a candidate sidecar, not the truth store and not the final admission policy. SQLite remains the truth store, and Substrate reloads canonical nodes before returning search results.

## Provider Contract

The eval expects an OpenAI-compatible embeddings endpoint:

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

The command writes a report under `reports/zvec-provider-embedding-*` unless `--output` is supplied.

## Options

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
- `embedding_usage`: provider requests, embedded text count, input character count, and failed request count.
- `zvec_health`: missing, orphan, and stale sidecar diagnostics.

If raw Zvec hit rate is strong but final Substrate hit rate is weaker, the provider embeddings are finding useful candidates but the final canonical scorer is still acting as a lexical/structured gate. That is a search-contract boundary, not a provider failure.
