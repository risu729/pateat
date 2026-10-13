# Third-party notices

The extension includes the selected shadcn/ui Base UI Button adaptation. Its local
cryptographic host and synthetic compatibility probes use the official Bitwarden OSS
SDK, OTPAuth, Noble hashes, Noble curves, tldts and tldts-core, cbor2 and @cto.af/wtf8,
its IndexedDB access uses idb, its IDs use uuid, and its messages to the background use
@webext-core/messaging with @aklinker1/zero-serialize-error. Their attribution and
license notices are kept in the
[packaged notice](apps/extension/public/THIRD-PARTY-NOTICES.md), which WXT copies into
the distributed extension.

The service's owner web UI includes the same Button adaptation and bundles React,
Base UI, TanStack Query, Valibot and Lucide icons. Its notices are in
[services/api/public/manage/assets/notices.md](services/api/public/manage/assets/notices.md)
and the `licenses.md` its build generates, and the page links both.

The real-page evaluation corpus
([packages/inference/src/corpus/formasaurus.json](packages/inference/src/corpus/formasaurus.json))
is derived from the saved pages and annotations of
[Formasaurus](https://github.com/scrapinghub/Formasaurus). Formasaurus and its
annotations are published under the MIT License (copyright 2015 Mikhail Korobov, as its
documentation states). The short page text in each observation (titles, headings and
labels) belongs to the sites themselves. No page HTML is included; each case keeps the
derived observation, its label and the Formasaurus page name.

> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright notice and this permission notice shall be included in all copies
> or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
> PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
> HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
> OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The Japanese page corpus
([packages/inference/src/corpus/japanese.json](packages/inference/src/corpus/japanese.json))
holds observations of six public login pages, each named by its origin and path. The
short page text in each observation (titles, headings and labels) belongs to those
sites. No page HTML is included.
