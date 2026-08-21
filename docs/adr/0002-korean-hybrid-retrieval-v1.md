# ADR 0002: Korean hybrid retrieval v1

Status: accepted by Plan2Agent Gate B for `v9-korean-hybrid-retrieval-evaluation`

BuildLore selects a dependency-free lexical strategy identified as `buildlore-unicode-hangul-ngram@1`. It normalizes text to NFC, applies Unicode lowercase, retains Unicode Letter/Number word tokens, and adds Hangul grapheme bigrams and trigrams within word-token boundaries. The scorer combines unique query word, bigram, and trigram coverage with weights 0.5, 0.3, and 0.2, renormalizing components absent from the query. Scores are rounded to six decimal places and ties use the qualified page ID.

The selected strategy improves the frozen spacing and morphology cases while preserving exact Korean and mixed code-symbol retrieval. It is deterministic, offline, local to the selected project corpus, and introduces no runtime dependency. `Intl.Segmenter` is rejected for canonical ranking because its word-like classification is implementation-dependent. Garu is MIT licensed, but the candidate is retained only as an exact-version, sanitized recorded ranking: adding its WASM runtime and model artifact would increase dependency, startup, distribution, and index-production cost without a justified quality benefit on the v1 corpus. The evaluator therefore reports Garu's recorded quality metrics and explicit unavailable index-size reason while deferring runtime adoption to a later Gate. Upstream tokenizer changes, deep imports, and a compiler fork remain excluded.

Semantic truthfulness remains rank-based. BuildLore converts the public SDK result order to reciprocal rank and hybrid search keeps the fixed 0.5 lexical-rank plus 0.5 semantic-rank fusion. Public evidence reports only page/source identity and bounded field/match-kind counts; it never exposes tokens, snippets, provider responses, or source bodies.

A successful non-review compile records the configured actual embedding provider/model identity in project-confined compiler state. Semantic and hybrid search require that marker to match current configuration. Missing or mismatched identity yields lexical partial fallback, `embedding-index-outdated`, and an explicit compile recovery action; it never triggers an automatic rebuild or provider call.

`npm run eval:retrieval` evaluates the versioned five-category corpus with provider-free lexical code and recorded semantic/morphology fixtures. Recall@5 and MRR are deterministic quality gates. Latency and index byte measurements are environment-qualified observations and are comparable only for the same runner identity.
