pdf.js (pdfjs-dist) v6.2.108 — legacy ESM build
Upstream: https://github.com/mozilla/pdf.js
License: Apache-2.0 (see LICENSE)

Vendored rather than loaded from a CDN because the MV3 content security
policy blocks remote script. Only the two files needed for text extraction
are included; the sandbox/annotation builds are not.
