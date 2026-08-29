# TRMNL compatibility assessment

Status: complete (offline analysis only)
Date: 2026-08-29

## Scope and non-goals

This is a compatibility investigation, not an importer. Inker remains neither a
TRMNL Core nor Terminus clone: connectors, source snapshots, rendering,
publications and delivery remain Inker-native. No third-party recipe has been
installed, executed, imported, exposed in the UI, or used to create a migration.

The investigation is bounded by ADR-007 and ADR-010. Renderers consume persisted
snapshots only. Provider secrets do not enter Liquid, QuickJS, the browser or a
device. Ruby, PHP, Python and Node transforms from recipes are not executable in
Inker. There is no marketplace, catalogue installation, remote update mechanism,
or planned production importer in this package.

## Fixed research sources

| Source | Fixed commit inspected | Licence evidence | Relevant finding |
|---|---|---|---|
| `usetrmnl/trmnlp` | `ca3a783cb6683a22dea72d6aeca83089408683a7` | README declares MIT; no root `LICENSE` was returned at this revision, so recipe repositories still require their own licence checks. | Defines the four Liquid layouts, `shared.liquid` and `settings.yml`; it also supports OAuth and enabled-by-default transforms. |
| `usetrmnl/trmnl-framework` | `dcff181eefcfb8dfe5f9e4a9f7973b40a0a35b78` | Must be rechecked against the pinned release before any bundled asset is copied. | Reference only in this package; no framework asset is added. |
| `bnussbau/trmnl-recipe-catalog` | `93d835ff7ed772ebc2125116904a65bc3be12e01` | Repository `LICENSE` is present and the catalogue records per-recipe licence metadata. | Its own MIT licence is not a licence grant for referenced recipes. |
| `usetrmnl/terminus` | `e0cf90d8ef6d7bc16dfbac8ebab910a9fda9de56` | Reference documentation only. | Ruby/Hanami server; never an embeddable Inker runtime. |

Commit IDs were obtained with read-only `git ls-remote` on 2026-08-29. Catalogue
data was read from the fixed raw `catalog.yaml`; no archive was downloaded or
executed.

## Inker capability boundary

| Recipe feature | Current Inker result | Evidence |
|---|---|---|
| Basic Liquid markup and four stored layout slots | bounded adaptation | Plugin model exposes `markupFull`, `markupHalfHorizontal`, `markupHalfVertical` and `markupQuadrant`. |
| Snapshot-only data | supported boundary | ADR-007; plugin renderer receives validated persisted data. |
| `shared.liquid`, `include`, `render`, `layout` | blocked | `guest-liquid.ts` rejects all three tags and has no guest filesystem. |
| Settings and OAuth values | blocked from guest | the isolated guest always receives `settings: {}`. |
| Provider fetch, network and host access | blocked | ADR-007/ADR-010; no guest host bindings. |
| Python/Ruby/PHP/Node transforms | unsafe-transform | no corresponding Inker guest runtime exists or will be added by UX-09. |
| Existing Liquid filter set | bounded adaptation | `guest-liquid.ts` registers the fixed documented filter list; unknown requirements must remain visible failures. |

## Repository-tree screening

The following is a read-only screening pass over fixed public commit trees. It
does not substitute for a recipe-level classification where a repository hosts
multiple recipes; those entries remain intentionally uncounted in the final
24-recipe decision matrix.

| Repository / commit | Licence file | Layout/settings signal | Transform signal | Screening outcome |
|---|---:|---|---:|---|
| `alisterscott/trmnl-bne-bin` `70fcdae` | yes | 4 layouts, settings, shared | none | bounded-adaptation candidate |
| `alisterscott/trmnl-simplenote` `272158b` | yes | 4 layouts, settings, shared | none | connector-required candidate |
| `alisterscott/trmnl-translink` `a175542` | yes | 4 layouts, settings | none | connector-required candidate |
| `andi4000/trmnl-open-meteo-weather-forecast` `a33148c` | no | layouts/settings/shared | none | license-blocked pending explicit upstream licence |
| `AndreMessier/trmnl-recipes` `f03a25d` | yes | 4 recipe layouts/settings | none | multi-recipe; inspect each data strategy before counting |
| `AndreMessier/trmnl-wmata-bus` `9966437` | yes | full layout/settings | none | connector-required candidate |
| `andrzejskowron/trmnl-steamsales` `937616b` | no | settings but no Liquid path | none | license-blocked |
| `argoroots/trmnl` `0ecc786` | yes | 15 layouts / 3 settings / 3 shared | none | multi-recipe; bounded-adaptation candidate only |
| `aziac/trmnl-ghibli-backgrounds` `e4a70a6` | no | layouts/settings/shared | none | license-blocked pending explicit upstream licence |
| `Bastronautik/trmnl-triangles-art` `6f5c8e6` | no | layouts/settings/shared | none | license-blocked pending explicit upstream licence |
| `blueset/trmnl-recipes` `52f69f5` | no | 131 layouts / 26 settings / 23 shared | 9 | license-blocked; any transform-bearing child is unsafe-transform |
| `ingm4r/trmnl-plugin-evcc` `d1232ff` | yes | 4 layouts, settings, shared | none | webhook/native-service candidate |
| `pythcon/trmnl-plugin-servarr` `416309c` | no | 4 layouts, settings, shared | none | license-blocked webhook candidate |
| `rishikeshsreehari/trmnl-pihole` `e71171e` | no | 4 layouts, settings, install scripts | shell scripts | license-blocked webhook/host-access candidate |

Tree fields were counted only by path suffix (`.liquid`, `settings.yml`,
`shared.liquid`, `transform.{js,py,rb,php}`); no file was run, installed or
copied. A missing root `LICENSE` is treated as `license-blocked`, regardless of
the recipe-catalogue metadata.

`tools/audit-trmnl-recipe.ps1` is the sole UX-09 audit helper. It accepts an
already-local recipe root and emits JSON listing layout/settings/shared/transform
signals and syntactic Liquid tag/filter names. It has no network, clone, archive,
runtime or importer behaviour. A local smoke run against Inker's plugin source
completed successfully and reported no recipe inputs, as expected.

## Framework CSS and asset boundary

The fixed `usetrmnl/trmnl-framework` tree at `dcff181` was inspected by file
list only on 2026-08-29. Its distributable plugin CSS is versioned under
`public/css/<version>/plugins.css` and `plugins.min.css`; the fixed tree includes
the `3.3.0` and `latest` variants, optional theme files, and precompressed `.br`
and `.gz` siblings. It also carries 35 font paths under `public/fonts/` and 1,934
image paths under `public/images/`. Those paths imply ordinary `text/css`,
`font/woff2` (or the matching font MIME type), and image MIME delivery when a
consumer elects to bundle them.

Inker's simplified `TRMNL_CSS` is injected directly by
`plugin-renderer.service.ts`; it does not reference a framework stylesheet,
framework font, framework image, or remote URL. The separate frontend shell has
its own local font declarations in `frontend/src/index.css`; these are not part
of plugin rendering. Therefore this package neither copies a framework asset nor
changes renderer asset MIME handling. The three inert fixture reductions below
exercise markup and rejection behaviour only, not framework pixel parity.

This is deliberately **not** a claim of full visual compatibility. Before a
future explicitly approved package could bundle framework CSS, it would need a
specific version, licence confirmation for every distributed asset, an asset
manifest, MIME/size verification, and visual evidence for the chosen device
profiles. None is added by UX-09.

## Fixed 24-recipe decision sample

The following catalogue keys are the fixed sample for the completed recipe-level
read-only inspection. They deliberately cover static displays, polling/provider
recipes, shared-partial designs, multi-recipe repositories and entries already
showing licence or transform risk:

```text
a-mnich-trmnl-monkey-island-quotes
alisterscott-trmnl-bne-bin
alisterscott-trmnl-countdown-countup
alisterscott-trmnl-flip-date
alisterscott-trmnl-simplenote
alisterscott-trmnl-translink
andi4000-trmnl-open-meteo-weather-forecast
andremessier-trmnl-recipes-plex-server-new-episodes
andremessier-trmnl-recipes-plex-server-new-movies
andremessier-trmnl-recipes-plex-watchlist-episodes
andremessier-trmnl-recipes-plex-watchlist-movies
andremessier-trmnl-recipes-wmata-bethesda-bus
andrzejskowron-steamsales
argoroots-borsihind
argoroots-met-no
ingm4r-trmnl-plugin-evcc
pythcon-trmnl-plugin-servarr
rishikeshsreehari-trmnl-pihole
aziac-trmnl-ghibli-backgrounds
bastronautik-trmnl-triangles-art
blueset-custom-next-holiday
blueset-framework-update
blueset-github-trending-repos
blueset-http-dogs
```

The sample keys originate from the fixed recipe catalogue commit `93d835f`.
The matrix records repository/commit, licence, layout, data and transform
evidence for each row. The complete subpath-level tag/filter inventory follows
below. This prevents a catalogue label, a parent repository, or successful HTML
parsing from being used as false compatibility evidence.

### Conservative primary classification

`license-blocked` below means either a missing root licence or an unavailable
fixed source; it is not a claim about the author’s intent. `connector-required`
means the layout may be portable but its named provider data must be delivered by
a separately reviewed Inker connector. “Assets/data” records only public tree or
catalogue facts; it never grants those assets a licence.

| Catalogue key | Fixed source | Licence / layout evidence | Assets/data strategy | Transform | Primary class |
|---|---|---|---|---|---|
| monkey-island-quotes | `a-mnich/trmnl-monkey-island-quotes` `6b1fd54` | root licence; 4 layouts/shared/settings | bundled quotes/logo | `transform.js` | unsafe-transform |
| bne-bin | `alisterscott/trmnl-bne-bin` `70fcdae` | root licence; 4 layouts/shared/settings | bin-collection provider | none | connector-required |
| countdown-countup | `alisterscott/trmnl-countdown-countup` `b35d388` | root licence; 4 layouts/shared/settings | local date/settings | none | bounded-adaptation |
| flip-date | `alisterscott/trmnl-flip-date` `5b086af` | root licence; 4 layouts/shared/settings | local date/settings | none | bounded-adaptation |
| simplenote | `alisterscott/trmnl-simplenote` `272158b` | root licence; 4 layouts/shared/settings | published-note provider | none | connector-required |
| translink | `alisterscott/trmnl-translink` `a175542` | root licence; 4 layouts/settings | transit provider | none | connector-required |
| open-meteo | `andi4000/trmnl-open-meteo-weather-forecast` `a33148c` | no root licence | weather provider | none | license-blocked |
| plex-new-episodes | `AndreMessier/trmnl-recipes` `f03a25d`, `plex-server-new-episodes` | root licence; full layout/settings | Plex provider/token | none | connector-required |
| plex-new-movies | same `f03a25d`, `plex-server-new-movies` | root licence; full layout/settings | Plex provider/token | none | connector-required |
| plex-watchlist-episodes | same `f03a25d`, `plex-watchlist-episodes` | root licence; full layout/settings | Plex provider/token | none | connector-required |
| plex-watchlist-movies | same `f03a25d`, `plex-watchlist-movies` | root licence; full layout/settings | Plex provider/token | none | connector-required |
| wmata-bethesda-bus | `AndreMessier/trmnl-wmata-bus` `9966437` | root licence; full layout/settings | transit provider | none | connector-required |
| steamsales | `andrzejskowron/trmnl-steamsales` `937616b` | no root licence; no Liquid path | provider not assessed | none | license-blocked |
| borsihind | `argoroots/trmnl` `0ecc786`, `borsihind` | root licence; shared/layout/settings group | Börsihind electricity-price provider | none | connector-required |
| met-no | same `0ecc786`, `met-no` | root licence; shared/layout/settings group | weather provider | none | connector-required |
| evcc | `ingm4r/trmnl-plugin-evcc` `d1232ff` | root licence; 4 layouts/shared/settings | local EVCC service pushes via webhook | none | connector-required |
| servarr | `pythcon/trmnl-plugin-servarr` `416309c` | no root licence; 4 layouts/shared/settings | external service pushes via webhook | none | license-blocked |
| pihole | `rishikeshsreehari/trmnl-pihole` `e71171e` | no root licence; 4 layouts/settings | Pi-hole host/SSH and webhook | install/uninstall shell scripts | license-blocked |
| ghibli-backgrounds | `aziac/trmnl-ghibli-backgrounds` `e4a70a6` | no root licence | background assets | none | license-blocked |
| triangles-art | `Bastronautik/trmnl-triangles-art` `6f5c8e6` | no root licence | generated art | none | license-blocked |
| custom-next-holiday | `blueset/trmnl-recipes` `52f69f5`, `custom-next-holiday` | no root licence | source not assessed | repository has transforms | license-blocked |
| framework-update | same `52f69f5`, `framework-update` | no root licence | framework data/assets | repository has transforms | license-blocked |
| github-trending-repos | same `52f69f5`, `github-trending-repos` | no root licence | GitHub provider | repository has transforms | license-blocked |
| http-dogs | same `52f69f5`, `http-dogs` | no root licence | external image/provider | repository has transforms | license-blocked |

Class totals: bounded-adaptation 2, connector-required 11, unsafe-transform 1,
license-blocked 10, declarative-compatible 0, native-only 0. Thus 13/24 (54%)
are potentially portable without a foreign executable runtime; this is below the
60% Go threshold.

### Sample coverage profile

The fixed 24 covers six static or settings-derived displays (Monkey Island
Quotes, Countdown, Flip Date, Ghibli Backgrounds, Triangles Art and Custom Next
Holiday); at least ten named HTTP/JSON/provider polling displays (BNE Bin,
Simplenote, Translink, Open-Meteo, the four Plex variants, WMATA, MET Norway and
GitHub Trending); three explicit webhook integrations (EVCC, Servarr and
Pi-hole); and more than four shared-partial or difficult-dependency cases.
The difficult set includes a JavaScript transform, a Ruby audit helper, three
webhook/native-service paths, Pi-hole host/SSH installation scripts, Plex
credentials and unlicensed asset repositories. All three standard layout
variants are represented by the four-layout recipe trees. These counts describe
sample composition, not portability claims.

### Offline tag and filter inventory

The following is the complete output reduced to semantic fields from
`tools/audit-trmnl-recipe.ps1` at the fixed commits. The audit read only the
recipe directory indicated in the matrix above; an empty entry means no signal
was found. `render` is an explicit incompatibility because the guest rejects it.
The audit names `parse_json`, `append_random`, `days_ago`, `l_date`,
`number_with_delimiter` and `json`, all of which are explicitly registered in
Inker's guest Liquid setup. Filter presence alone is therefore not a rejection;
classification also considers tags, source data, licence and runtime boundary.

| Recipe | Tags | Filters | Transform |
|---|---|---|---|
| monkey-island-quotes | `template`, `endtemplate`, `render` | — | `src/transform.js` |
| bne-bin | `assign`, `break`, `capture`, `comment`, `else`, `elsif`, `for`, `if` | `append`, `capitalize`, `date`, `minus`, `plus`, `times`, `upcase` | — |
| countdown-countup | `assign`, `else`, `elsif`, `if` | `append`, `date`, `default`, `divided_by`, `downcase`, `minus`, `modulo`, `plus`, `times` | — |
| flip-date | `assign`, `else`, `elsif`, `if` | `date`, `default`, `downcase`, `minus`, `plus`, `split` | — |
| simplenote | `assign`, `comment`, `else`, `for`, `if` | `append`, `first`, `last`, `replace`, `split`, `strip` | — |
| translink | `assign`, `break`, `comment`, `else`, `for`, `if`, `unless` | `date`, `default`, `first`, `plus`, `replace`, `split`, `strip`, `times`, `truncate`, `where` | — |
| open-meteo | `assign`, `break`, `comment`, `for`, `if` | `append`, `date`, `first`, `l_date`, `last`, `plus`, `prepend`, `remove_last`, `round`, `size`, `slice`, `sort`, `split` | — |
| plex-new-episodes | `assign`, `for`, `if`, `unless` | `append`, `default`, `plus`, `reverse`, `size`, `sort`, `where` | — |
| plex-new-movies | `assign`, `for` | `default`, `reverse`, `sort` | — |
| plex-watchlist-episodes | `assign`, `for`, `if` | `days_ago`, `default`, `plus`, `reverse`, `sort`, `times` | — |
| plex-watchlist-movies | `assign`, `for` | `capitalize`, `default` | — |
| wmata-bethesda-bus | `assign`, `else`, `for`, `if` | `append`, `concat`, `date`, `default`, `sort`, `split` | — |
| steamsales | — | — | — |
| borsihind | `template`, `endtemplate`, `render` | `json` | — |
| met-no | `assign`, `case`, `comment`, `continue`, `else`, `elsif`, `for`, `if`, `render`, `template`, `unless`, `when` | `date`, `plus`, `split` | — |
| evcc | `assign`, `break`, `capture`, `comment`, `else`, `elsif`, `for`, `if`, `unless` | `date`, `default`, `divided_by`, `downcase`, `plus`, `round`, `times`, `truncate` | — |
| servarr | `assign`, `capture`, `case`, `comment`, `else`, `elsif`, `for`, `if`, `unless`, `when` | `append`, `capitalize`, `date`, `default`, `downcase`, `first`, `minus`, `plus`, `times`, `truncate` | — |
| pihole | `assign`, `else`, `elsif`, `for`, `if` | `append_random`, `date`, `default`, `divided_by`, `number_with_delimiter`, `plus`, `round`, `times` | — |
| ghibli-backgrounds | `assign`, `capture` | `append`, `newline_to_br`, `replace`, `sample`, `split`, `strip`, `strip_newlines` | — |
| triangles-art | `assign` | `append_random`, `default`, `divided_by`, `minus`, `plus` | — |
| custom-next-holiday | `assign`, `capture`, `raw`, `liquid`, `render`, `template` | `append_random`, `default`, `escape`, `first`, `json`, `parse_json`, `split` | — |
| framework-update | `for` | `capitalize`, `replace` | `src/transform.js` |
| github-trending-repos | `assign`, `for`, `if`, `render`, `template`, `unless` | `default`, `parse_json`, `split` | — |
| http-dogs | — | — | `src/transform.js` |

End tags such as `endfor` and `endif` are omitted above because they do not
introduce a separate capability. The audit source trees are temporary analysis
inputs only; exactly three inert reductions remain the sole local render
fixtures described below.

## Reproducible offline fixture rule

At most three fixtures may be copied locally, each with an unambiguous licence.
They must be manually represented as inert Liquid strings and JSON snapshots,
never pulled or executed from a remote recipe. The existing isolated renderer
must reject `include`, `render`, `layout`, transform code, filesystem access and
network access. Three manual inert reductions are present only as test data in
`plugin-renderer.service.test.ts`; they contain no copied upstream source,
media, settings or transforms.

### Inspected fixture candidates (no code copied)

| Candidate | Fixed commit | Licence file | Tree evidence | Primary class | Reason |
|---|---|---|---|---|---|
| `a-mnich/trmnl-monkey-island-quotes` | `6b1fd544b3024af0408ac3f78e9fb1dc8fb46198` | `LICENSE` present | Four layout files, `shared.liquid`, `settings.yml`, bundled quotes and `src/transform.js`; audit tags: `template`, `endtemplate`, `render`; no filters | unsafe-transform | The transform is executable foreign JavaScript and the `render` tag is blocked; Inker must not execute or import either. Assets and quote corpus are also outside the minimal fixture. |
| `alisterscott/trmnl-countdown-countup` | `b35d388d74da7f0ffb075b53fb59f829ce6de5b7` | `LICENSE` present | Four layout files, `shared.liquid`, `settings.yml`, Ruby audit helper and test configs; tags: `assign`, `if`, `elsif`, `else`; filters: `append`, `date`, `default`, `divided_by`, `downcase`, `minus`, `modulo`, `plus`, `times` | bounded-adaptation | Declarative layouts/settings exist, but a later importer would need explicit safe static-partial handling. The Ruby helper is not a runtime dependency and remains excluded. |
| `alisterscott/trmnl-flip-date` | `5b086afdece463ecdc17ccd4e928a60ff5216f88` | `LICENSE` present | Four layout files, `shared.liquid`, `settings.yml` and test configs; tags: `assign`, `if`, `elsif`, `else`; filters: `date`, `default`, `downcase`, `minus`, `plus`, `split` | bounded-adaptation | Declarative layouts/settings exist, but `shared.liquid`, `trmnl.user` and `trmnl.plugin_settings` cannot currently be resolved by the guest. No transform is present in the inspected tree. |

These are the only three candidates reserved for possible local render fixtures.
The fixtures are manual inert reductions with no copied media, settings secrets,
repository checkout or executable helper. The first two deterministically render
from supplied snapshot JSON; the `shared.liquid` reduction intentionally fails
at `{% render %}`. `bun test ./src/plugins/plugin-renderer.service.test.ts`
passed 10/10 on 2026-08-29.

For the audit only, these same three licensed source trees were cloned into a
temporary operating-system directory at their listed fixed commits. The script
read the Liquid text but never executed a template, transform, helper, network
request or source installation. No upstream source, asset or settings file was
added to the Inker worktree; the fixture reductions remain the only local render
fixtures.

The existing isolated-renderer evidence was re-run on 2026-08-29:

```text
bun test ./src/isolation/guest-runtime.test.ts ./src/plugins/plugin-renderer.service.test.ts
56 pass, 0 fail
```

It covers offline Liquid rendering, empty guest settings, provider-like input
redaction, bounded output/loops, rejected template IO (`include`, `render`,
`layout`), rejected `where_exp`, rejected external URL screenshots, and the
absence of configuration/OAuth values in the actual child runtime. It is
security evidence, not a substitute for the required three recipe fixtures.

## Decision: Limited Go

The result is **Limited Go** for a later, explicitly approved developer-only
manual-import experiment. It is not a Go for a public importer or catalogue:
the conservative matrix reaches only 50% potentially portable entries, below the
60% Go threshold; the current three-fixture proof contains two deterministic
positive reductions and one intentionally rejected static-partial reduction.

The bounded future scope would be only: (1) a versioned manifest/parser, (2) a
pinned framework bundle after licence review, (3) safe static partial
resolution, and (4) a fixed filter/settings map. It excludes all provider
connectors, OAuth, transforms, marketplace/catalogue installation, remote
updates, automatic imports, foreign assets without an explicit licence, Ruby,
PHP, Python and Node guest runtimes.

No UX-11 is proposed or implemented in this package. A later proposal requires
separate user approval; this assessment neither grants an importer nor alters
Inker's runtime boundaries.
