# Pipeline maintenance

Renovate updates library lockfiles and image pins; the shared CI gate precedes
publication. Docker rebuilds refresh distribution security packages, including
Redis, instead of freezing an obsolete Debian package revision.

The amd64 Chrome headless-shell version is read from the locked Puppeteer package
at build time. Puppeteer and Chrome therefore update together while a given
lockfile remains reproducible. arm64 uses distribution Chromium. Renderer,
SQLite/Redis integration, image startup, fault and backup/restore gates remain
required after toolchain changes. Node version pins in .node-version, package
engines and Docker COPY images must stay aligned.

Puppeteer 25.11.0 supersedes the old Chrome 131 baseline. Browser updates may alter
font metrics; review renderer regression failures instead of disabling them.
