# CAPTCHA solving: existing approaches and reported accuracy

Researched: 2026-10-12, from public web sources only. Nothing was built, bought or
tried. On 2026-10-12 (05:35 UTC) the owner said that automating reCAPTCHA and similar
challenges is out of Pateat's scope because it is heavy, and asked what existing
solutions there are, how they work and how accurate they are. This note is an overview
survey, not a design. Prices are list prices seen on 2026-10-12; every number is
labelled as a **vendor claim** or an **independent** measurement. Most independent
results are the authors' own setups at one point in time, and the vendors changed their
challenges afterwards.

## Summary

| Approach | How it works | Reported success | Source type |
| --- | --- | --- | --- |
| Paid solver services (human, AI or both) | The client sends the site key and page URL; the service returns a token that the client puts into the page | reCAPTCHA v2 and Turnstile 100%, hCaptcha 58–100%, reCAPTCHA v3 (score > 0.5) 0–63%, about 23% on average | Independent preprint, 2026 |
| Audio-challenge speech recognition (Buster, unCaptcha) | Requests reCAPTCHA's audio challenge and transcribes it with a speech-to-text API | 85% (2017), about 90% (2019), over 97% (2021, not peer reviewed) | Independent |
| Image object detection (YOLO and similar) | Classifies or segments the challenge images | reCAPTCHA v2 71% (2016), 83% (2020), 100% eventual pass (2024); hCaptcha 96% (2021) | Independent, authors' own setups |
| Multimodal LLM agents | A vision-language model looks at the page and clicks | 40% best agent on a 20-type benchmark (humans 93%), 61–71% on 26 visual types; often fails reCAPTCHA v3 and hCaptcha | Independent, 2025–2026 |
| Avoiding the challenge | Silent scoring (reCAPTCHA v3, Turnstile), Private Access Tokens, accessibility cookies, signed agents | Apple PAT removes "nearly 100%" of Cloudflare CAPTCHAs on supported Apple devices | Vendor claim |

Plesner et al. (2024) and Broken Gates (2026) both find that for reCAPTCHA v2/v3 and
Turnstile the browser's reputation (cookies, history, fingerprint) decides more than
whether the puzzle can be solved. Paid solver services pass reCAPTCHA v2, Turnstile and
hCaptcha at or near 100% through at least one service, but not reCAPTCHA v3.

## Solver services

The usual mechanism ([2Captcha](https://2captcha.com/)): the client submits the image,
or for token CAPTCHAs the site key and page URL, gets a task ID, and polls for the
answer. For reCAPTCHA, hCaptcha and Turnstile the answer is a response token that the
client writes into the page's hidden response field. 2Captcha now describes itself as
"AI-first": low-confidence tasks go to human workers.

| Service | Method (vendor's description) | List price per 1,000 | Vendor's accuracy or speed claim |
| --- | --- | --- | --- |
| [2Captcha / RuCaptcha](https://2captcha.com/pricing) | AI first, humans for low confidence | Image $0.5–1; reCAPTCHA v2 $1–2.99; v3 $1.45–2.99; Turnstile $1.45 | "High accuracy", no number |
| [Anti-Captcha](https://anti-captcha.com/) | "100% of captchas are solved by human workers" | Image $0.5–0.7; reCAPTCHA v2 $0.95–2; v3 $1–2; Turnstile $2 | 5 s; "most accurate", no number |
| [DeathByCaptcha](https://www.deathbycaptcha.com/) | OCR plus a human team | Image $0.99–2; reCAPTCHA and Turnstile tokens $2.89 | "Over 90% correctness"; 5–10 s |
| [CapSolver](https://www.capsolver.com/) | AI; API, SDKs, a browser extension | reCAPTCHA v2 $0.8; v3 $1.0; v3 Enterprise $3.0; Turnstile $1.2 | Under 3–10 s; "high success rates", no number |
| CapMonster Cloud (Zennolab) | AI | $0.60–1.30 (as listed by [Broken Gates](https://arxiv.org/html/2607.18659); the vendor's page did not load) | Not seen on the vendor's site |
| [NopeCHA](https://nopecha.com/pricing) | AI; API and a browser extension | Subscriptions, e.g. $4.99/month for 2,000 solves/day | No number |

Independent measurements:

- [Ousat et al., "Broken Gates", arXiv:2607.18659](https://arxiv.org/abs/2607.18659)
  (preprint, 2026-07-21; [full text](https://arxiv.org/html/2607.18659)) tested seven
  services (2Captcha, Anti-Captcha, AZCaptcha, BestCaptchaSolver, CapSolver, CapMonster,
  ImageTyperz) against their own login pages behind each defense:
  - reCAPTCHA v2 checkbox and invisible: 100% for all seven.
  - Turnstile managed and invisible: 100% for the six that support it.
  - hCaptcha (only 2Captcha and ImageTyperz support it): Easy 100% for both; Hard 58%
    (2Captcha) and 100% (ImageTyperz).
  - reCAPTCHA v3 with a score above 0.5: BestCaptchaSolver 63%, ImageTyperz 41%,
    Anti-Captcha 30%, 2Captcha 26%, CapSolver, CapMonster and AZCaptcha 0%; about 23% on
    average.
  - Prices $0.10–5.00 per 1,000.
- [Motoyama et al., USENIX Security 2010](https://www.usenix.org/conference/usenixsecurity10/re-captchas%E2%80%94understanding-captcha-solving-services-economic-context)
  measured eight human-solver services on text CAPTCHAs: 86–89% correct for all but one,
  14 s median response, about $1–2 per 1,000 retail, and worker pay falling to about
  $0.75 per 1,000 by 2010.

## Browser extensions

- [Buster](https://github.com/dessant/buster): the person clicks its button on a
  reCAPTCHA; it requests the audio challenge and transcribes it with a configurable
  speech-to-text service (Google, IBM Watson, Microsoft Azure or Wit.ai). An optional
  native client simulates real input. It publishes no success rate; its
  [store listing](https://addons.mozilla.org/firefox/addon/buster-captcha-solver/) says
  solving "is not guaranteed" and that more than a couple of challenges a day may lead
  to a temporary block.
- [NopeCHA extension](https://github.com/NopeCHALLC/nopecha-extension): sends challenges
  to the NopeCHA API (reCAPTCHA, FunCAPTCHA, AWS WAF, Turnstile, image and text). Only
  the old 0.3 line is open source. No published accuracy.
- CapSolver and other services ship similar extensions that call their paid APIs.
- [Silk – Privacy Pass Client](https://blog.cloudflare.com/privacy-pass-standard/)
  (Cloudflare, 2024): not a solver; it presents Privacy Pass tokens (see below).
  Cloudflare presents it as contributing to research on privacy-preserving signals.

## Research results

reCAPTCHA v2, images:

- [Sivakorn, Polakis, Keromytis, 2016](https://www.blackhat.com/docs/asia-16/materials/asia-16-Sivakorn-Im-Not-a-Human-Breaking-the-Google-reCAPTCHA-wp.pdf):
  deep-learning image annotation plus cookie manipulation; 70.78% of image challenges at
  about 19 s each.
- [Hossen et al., RAID 2020](https://arxiv.org/abs/2104.03366): YOLOv3 object detection;
  83.25% against live reCAPTCHA v2, about 20 s each.
- [Plesner, Vontobel, Wattenhofer, 2024](https://arxiv.org/abs/2409.08831): YOLO
  models; 100% eventual pass over repeated challenges. Humans and the bot needed about
  as many challenges, and passing depended heavily on cookies and browser history.

reCAPTCHA v2, audio:

- [unCaptcha, Bock et al., USENIX WOOT 2017](https://uncaptcha.cs.umd.edu/): free
  online speech-to-text engines combined; 85.15% on over 450 live challenges, 5.42 s.
  Google then changed the audio from digits to spoken phrases.
- unCaptcha2 (same team, 2019): Google's own Speech-to-Text on the phrase audio; about
  90%. Google added countermeasures.
- Tschacher, 2021, as reported by
  [The Hacker News](https://thehackernews.com/2021/01/google-speech-to-text-api-can-help.html)
  (proof of concept, not peer reviewed): over 97%, limited by audio rate limits and
  fingerprinting.

reCAPTCHA v3 (no challenge; a score from 0.0 to 1.0):

- [Akrout et al., 2019](https://arxiv.org/abs/1903.01003) (not peer reviewed): a
  reinforcement-learning mouse agent got a high score in 96.7–97.4% of runs on the
  authors' test page.
- Broken Gates (2026): only one of the LLM agent setups passed v3. Two agents with
  nearly the same input events got different results; the authors attribute it to one
  running in a real browser profile with persistent cookies and history, and conclude
  that the barrier is the trusted environment, not human-like behaviour. This rests on
  a single pair of agents.

hCaptcha:

- [Hossen and Hei, WOOT 2021](https://arxiv.org/abs/2104.04683): object detection on a
  CPU-only container; 95.93% (259 of 270 live challenges), 18.76 s.
- Broken Gates (2026): no LLM agent both passed and submitted; one bypassed Easy but did
  not submit.

Cloudflare Turnstile: no peer-reviewed attack paper was found. Broken Gates (2026)
reports 100% for solver services, and its Table 3 marks several LLM agents as passing
(Browser-Use and NanoBrowser in both modes; Skyvern and BrowserOS in invisible mode).

Multimodal LLM agents:

- [Oedipus, Deng et al., 2024](https://arxiv.org/abs/2405.07496): GPT-4 63.5% on four
  reasoning-CAPTCHA types (Arkose, GeeTest, NetEase).
- [Teoh et al., "Are CAPTCHAs Still Bot-hard?", USENIX Security 2025](https://www.usenix.org/conference/usenixsecurity25/presentation/teoh):
  60.7% on 2,600 challenges of 26 visual types; 70.6% on live challenges over 30 days.
- [Open CaptchaWorld, Luo et al., NeurIPS 2025](https://arxiv.org/abs/2505.24878):
  humans 93.3%; best agent (Browser-Use with o3) 40.0%; Claude 3.7 Sonnet 20%.
- [COGNITION, Wang et al., USENIX Security 2026](https://arxiv.org/abs/2512.02318):
  seven models on 18 real CAPTCHA types do well on recognition and poorly on fine
  localization and multi-step spatial reasoning; hardening one type took the best
  model from over 95% to 0%.
- [ReCAP, Chen et al., ICML 2026](https://arxiv.org/abs/2603.23559): a GUI agent
  fine-tuned for CAPTCHAs; the authors report 84.2% on their own benchmark against
  56.8–59.9% for general frontier models.
- At launch in January 2025 OpenAI said Operator hands CAPTCHAs back to the user. In
  July 2025 users posted screenshots of ChatGPT agent ticking Cloudflare's "verify you
  are human" box with no puzzle shown; this was not reproduced in a controlled test.

Humans, for comparison
([Searles et al., USENIX Security 2023](https://www.usenix.org/conference/usenixsecurity23/presentation/searles),
1,400 participants, 14,000 live CAPTCHAs): reCAPTCHA checkbox 3.1–4.9 s; reCAPTCHA
images 15–26 s at about 81% accuracy; hCaptcha 18–32 s at 81.4% (easy) and 70.6%
(hard). The paper's bot figures are taken from earlier papers and are mostly above
96%; it concludes that bots can now match or beat people on both time and accuracy.

## Avoiding the challenge instead of solving it

- **Silent scoring.** reCAPTCHA v3 returns a score per action with no challenge; the
  site picks the threshold (0.5 by default)
  ([docs](https://developers.google.com/recaptcha/docs/v3)). reCAPTCHA keys moved into
  Google Cloud between 2025 and Q1 2026, and the product is now part of Google Cloud
  Fraud Defense
  ([migration](https://docs.cloud.google.com/recaptcha/docs/migration-overview)).
  [Turnstile](https://developers.cloudflare.com/turnstile/) runs non-interactive browser
  checks (proof of work, web API probes, behaviour) and shows a checkbox only when the
  risk is high (managed mode), or never (non-interactive and invisible modes).
  Cloudflare says Managed Challenge cut its own CAPTCHA use by 91% (vendor claim).
  hCaptcha has passive and invisible modes in its paid tiers
  ([FAQ](https://docs.hcaptcha.com/faq)).
- **Private Access Tokens / Privacy Pass**
  ([RFC 9576](https://www.rfc-editor.org/rfc/rfc9576.html),
  [RFC 9577](https://www.rfc-editor.org/rfc/rfc9577.html),
  [RFC 9578](https://www.rfc-editor.org/rfc/rfc9578.html), June 2024). The site sends a
  token challenge; an attester (Apple, from the device) vouches for the client and an
  issuer (such as Cloudflare) blind-signs a token, so the site learns only "valid
  client" and Apple does not learn the site. Built into iOS 16 and macOS 13 and later;
  Cloudflare says it removes
  ["nearly 100%" of CAPTCHAs](https://blog.cloudflare.com/eliminating-captchas-on-iphones-and-macs-using-new-standard/)
  for those users (vendor claim). Chrome has no native support; only Cloudflare's Silk
  research extension. Chrome's separate
  [Private State Tokens](https://privacysandbox.google.com/protections/private-state-tokens/developer-guide)
  are still supported, but Google says they should not be used alone to decide trust.
- **Accessibility routes.** reCAPTCHA offers an
  [audio challenge](https://support.google.com/recaptcha/answer/6175971).
  [hCaptcha's accessibility cookie](https://www.hcaptcha.com/accessibility) is still
  offered: a person registers by email and gets a cookie that passes challenges a few
  times a day. The W3C note
  [Inaccessibility of CAPTCHA](https://www.w3.org/TR/turingtest/) (Group Draft Note,
  2021-12-16) surveys the alternatives.
- **Signed agents.** An automated client signs its HTTP requests
  ([Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/),
  RFC 9421 signatures with a published key directory; IETF
  [webbotauth](https://datatracker.ietf.org/doc/charter-ietf-webbotauth/) working group
  since 2025-10). Cloudflare's
  [signed agents](https://blog.cloudflare.com/signed-agents/) (2025-08-28) started with
  ChatGPT agent, Goose, Browserbase and Anchor Browser. The signature identifies the
  operator; each site still decides whether to let it through. It is meant for agent
  platforms, not for an extension acting inside a person's browser.

## Terms and legal caveats

- [Google's Terms of Service](https://policies.google.com/terms) (effective 2026-07-30)
  forbid "bypassing our systems or protective measures".
  [hCaptcha's terms](https://www.hcaptcha.com/terms) (2025-11-17) forbid passing
  challenges with bots, scripts or AI. Cloudflare publishes no specific CAPTCHA clause
  for challenges on its customers' sites, but its docs say automated browsers are
  [not supported for solving production challenges](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/).
  Each site's own terms usually forbid automated access as well.
- In the United States, courts have treated a CAPTCHA as a likely access control under
  the DMCA anti-circumvention rule
  ([Ticketmaster v. RMG, 2007](https://blog.ericgoldman.org/?p=9383), disputed by
  commentators), ticket bots that defeated CAPTCHAs led to
  [wire-fraud pleas](https://www.fbi.gov/newark/press-releases/2010/nk111810.htm) in
  2010, and Microsoft
  [seized the domains](https://cyberscoop.com/microsoft-seizes-infrastructure-of-top-cybercrime-group/)
  of three CAPTCHA-solving services tied to fraudulent account creation in 2023.
- Human solving relies on low-paid workers: in 2012 one solving service told its workers
  they would earn about $0.35–1 per 1,000 solves
  ([Krebs](https://krebsonsecurity.com/2012/01/virtual-sweatshops-defeat-bot-or-not-tests/)).

## Fit with Pateat

The owner placed CAPTCHA solving out of scope (2026-10-12), so a CAPTCHA stays the
person's step. [ADR 0029](../adr/0029-local-sign-in-state.md) counts a visible
reCAPTCHA, hCaptcha or Turnstile widget after a login step as a sign that authentication
goes on (S4), not as a login failure. Every solving approach above that reaches high
success either sends the site key and page URL to a paid third party or breaks the
challenge vendor's terms. The avoidance routes do not fit either: Private Access
Tokens need a supported Apple device, signed agents are for agent platforms, and
accessibility cookies are meant for people who need them. Pateat runs in the person's
own Chrome profile, which Plesner et al. (2024) and Broken Gates (2026) found is what
silent scoring rewards, so challenges may be rarer there than for cloud agents
(inferred from those studies; not measured for Pateat).
