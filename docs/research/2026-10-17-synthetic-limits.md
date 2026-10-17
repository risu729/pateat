# Offline synthetic limit measurements

Measured on 2026-10-17 with the repository-pinned Node 26.12.0, against the configured
limits on main at
[the baseline revision](https://github.com/risu729/pateat/commit/866fe69). The
[saved JSON report](2026-10-17-synthetic-limits.json) records hashes of the four source
files read, the exact constants, settings-envelope calculation and cache boundary
measurements. No real account, browser profile, network request, deployed service or
paid inference was used.

## Reproduce

From a checkout with the pinned tools installed:

```sh
mise run measure:limits
```

The dependency-free [script](../../scripts/measure-limits.mjs) reads numeric constants
from their owning source files. It accepts positive integer literals and products,
and fails if declarations move or change syntax; it never executes source text.
It prints JSON to stdout. Save with shell redirection if needed. Source hashes make
a changed configuration visible rather than silently comparing unrelated builds.

The script constructs synthetic recipes using fixed-width unique IDs and a synthetic
UUID for the device, then counts UTF-8 bytes of `JSON.stringify` on the same cache
wrapper fields used by `apps/extension/src/service/recipes.ts`. Binary search reports
both the largest fitting count and the next count that exceeds the limit. The script
asserts both boundaries. These are serialization calculations; they do not execute
Chrome storage or the production sync path.

## Results

The source constants were: 2,097,152 cache bytes (2 MiB), 1,000 active service recipes,
10 retained recipe revisions, 122,880 settings-document bytes (120 KiB), 131,072 API
body bytes (128 KiB) and 4,096 pairing-body bytes (4 KiB).

| Synthetic recipe shape | Recipe bytes | Cache bytes at 1,000 recipes | Largest count within 2 MiB | Bytes at that count | Bytes at next count |
| --- | ---: | ---: | ---: | ---: | ---: |
| One password page and one completion marker | 420 | 421,128 | 4,981 | 2,097,129 | 2,097,550 |
| Username then password; English controls/marker | 654 | 655,128 | 3,201 | 2,096,783 | 2,097,438 |
| Same two pages; Japanese controls/marker | 677 | 678,128 | 3,092 | 2,096,504 | 2,097,182 |
| Two pages; four distinct 120-character Japanese markers | 2,193 | 2,194,128 | 955 | 2,095,397 | 2,097,591 |

The first three examples fit at the service's active-count cap. The deliberately
wide-marker example exceeds the device byte cap at 956 recipes, before the service's
1,000-active-recipe cap. It makes the independent byte/count limits visible without
claiming a typical size for generated or real recipes. Counts above 1,000 are
hypothetical serialization capacity, not a service entitlement. Japanese text takes
more UTF-8 bytes than its JavaScript string length; the byte calculation includes
those bytes, JSON delimiters, commas, the wrapper and the cursor's digit count.

For a minified settings write at the largest supported `expectedRevision`
(9,007,199,254,740,990), the wrapper adds 61 bytes. A 122,880-byte settings document
therefore makes a 122,941-byte body, leaving 8,131 bytes under the API limit. This is
envelope arithmetic, not proof that an arbitrary document passes its schema. Added
whitespace, a different wire representation or future wrapper fields change it.

## Scope and acceptance limits

The script measures serialized synthetic data and configured constants. It does not
measure latency, memory, throughput, Chrome quota behavior, workerd/D1 resource usage,
provider/model correctness, paid usage, hosted enforcement or installed-Chrome
acceptance. The four shapes contain no TOTP handlers, alternate branches or chooser
recipes, and their marker text is deliberately synthetic. They are not a workload
corpus or an estimate of the owner's actual data.

Enforcement remains covered separately by existing tests:

- [Extension recipe sync tests](../../apps/extension/src/service/recipes.test.ts)
  exercise `cache-full` without replacing the prior cache.
- [Service sync tests](../../services/api/test/sync.test.ts) exercise active count,
  revocation/reactivation, retained revisions and owner-keyed rate limits. Their
  local limiter does not measure Cloudflare's approximate per-location binding.
- [Contracts](../../packages/contracts/src/sync.ts) define the settings document
  budget and recipe identity rules. Byte counts alone are not contract validation.

No claim is made here that those suites ran as part of this measurement. M6's
installed-Chrome/coexistence and resource/performance evidence remain open; the
[roadmap](../plan.md#phase-3-public-release) and
[service limits](../architecture.md#service-limits) retain that distinction.
