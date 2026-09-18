# Contributors

Every change in this repository lands with its tests in the same pull request, under a hard 100% line-coverage gate and every check `main` requires. That is an unusual bar for a project this size, and it means a merged pull request here is evidence about the person who wrote it, not only about the project.

So this is not a thank-you wall. Each entry links to the change itself, so a reader who does not know us can check the claim. If your name is here, the link is yours to use — a CV, a profile README, anywhere the question "what have you actually shipped" comes up.

Nothing here is counted. Not merged pull requests, not changed lines, not closed issues. A count sees how often somebody showed up and misses everything that matters about it: the care taken, the bug nobody else found, the answer written out for a stranger. So the rungs below are judgements rather than totals, and where one is not obvious the reason is written beside the name — [CONTRIBUTING.md](CONTRIBUTING.md#the-contributor-ladder) says what each rung means.

Everyone whose work is in `main` is here, maintainers included. Bots and coding agents are not — `dependabot`, `Copilot` and `claude` all appear in the repository's commit history and none of them is a person, so listing them beside people would blur the only thing this page is for. `git shortlog -sn` shows the whole history including theirs.

Within each rung, people are in the order they first landed a change.

## Maintainer

The people who carry the project: the releases, the review, and the decisions nobody else can make. Their work is most of the history and is not itemised here; the links are a sample.

### @cevheri

Organisation member. Wrote most of what is here.

- [Brought libSQL in over the Hrana protocol](https://github.com/libredb/libredb-studio/pull/511)
- [Added DuckDB as an embedded file engine](https://github.com/libredb/libredb-studio/pull/516)

### @yusuf-gundogdu

Organisation member. The agent model record, and the distribution inventory.

- [Ran ten models across every agent surface, 300 for 300](https://github.com/libredb/libredb-studio/pull/465)
- [Found two cloud marketplaces the inventory did not know about](https://github.com/libredb/libredb-studio/pull/577)

### @kaya-abdullah

Organisation member. The wire-compatible engines, and the first localized READMEs.

- [Caught Trino handing back every bigint past 2^53 rounded](https://github.com/libredb/libredb-studio/pull/460)
- [Added the Simplified Chinese and Japanese READMEs](https://github.com/libredb/libredb-studio/pull/317)

## Trusted contributor

### @harish18092002

The first person outside the core team to send anything at all, on 2025-12-25, when there was no contributing guide, no labeled issue and no reason to believe anyone would answer. Being first is a different act from being second.

- [Improved the query preview in the Save Query modal](https://github.com/libredb/libredb-studio/commit/ff22a5dd4f5b5a3fcd0c01339820ffa6035ae51f)

### @omerfarukbolat

The light theme rests on the shared token layer he built, and the export path escapes every field because of the pass he did over it. Both were the kind of change that moves the floor under everything else rather than fixing one thing.

- [Fixed the auth flow, middleware redirects and hooks cleanup](https://github.com/libredb/libredb-studio/pull/10)
- [Enforced the ESLint and TypeScript checks in CI, and fixed the component bugs they found](https://github.com/libredb/libredb-studio/pull/18)
- [Built a light theme through a shared token layer, and fixed four silent query-execution defects](https://github.com/libredb/libredb-studio/pull/384)
- [Escaped every field an export writes, and stopped a plan outliving its run](https://github.com/libredb/libredb-studio/pull/422)

### @suleymansurucu

Came the same day as the first, hours behind it, into the same empty repository. Two people decided this was worth their evening before there was anything here to promise them it would be.

- [Handled SQL queries in the demo connection, with a mock fallback](https://github.com/libredb/libredb-studio/commit/c6d3e10c5d5076f674af12f58d2244e0208e6c5b)

### @hbasria

Brought a fifth identity provider into the OIDC layer, and the branch he added is still what runs — `src/lib/oidc.ts` handles Zitadel's RP-initiated logout because of him. He arrived with the doc and the test in the same change, months before this repository wrote that down as a rule.

- [Added Zitadel OIDC integration support](https://github.com/libredb/libredb-studio/commit/d8227cbc)
- [Covered `OIDC_ROLE_CLAIM` in the Zitadel logout URL test](https://github.com/libredb/libredb-studio/commit/09d36a4d)

### @ugurpektas

Built out the admin section: the routes, the interactive UI around them, and the tests that hold it. He did it in one careful pass rather than leaving it half-finished for someone else.

- [Added the admin section routes and polished the interactive UI](https://github.com/libredb/libredb-studio/pull/231)

### @koraysrn

First into the agent layer, which nobody outside the core team had opened, and he has stayed in it since: its drive ownership, its PostgreSQL grounding and the history of finished runs are all partly his. He started in the part nobody volunteers for, a run behaving correctly when something goes wrong.

- [Enforced single-drive ownership in the agent, and refused post-close appends](https://github.com/libredb/libredb-studio/pull/419)
- [Aggregated the PostgreSQL grounding column read per table](https://github.com/libredb/libredb-studio/pull/537)
- [Kept the engine's own and extension-owned objects out of PostgreSQL agent grounding](https://github.com/libredb/libredb-studio/pull/625)
- [Added a History list of finished agent conversations, reopened from each run's own ledger](https://github.com/libredb/libredb-studio/pull/830)

### @hasnaintypes

Went wherever the work was: the login page, the admin fleet view, a license notice nobody had stated, and the provider docs whose citations had quietly rotted. Each one arrived finished, with the reasoning written down.

- [Closed the login hero's overflow at 1280x800](https://github.com/libredb/libredb-studio/pull/550)
- [Stated elkjs's EPL-2.0 license alongside the MIT license](https://github.com/libredb/libredb-studio/pull/552)
- [Summed the fleet's own byte figure instead of re-parsing display strings](https://github.com/libredb/libredb-studio/pull/551)
- [Replaced the stale line-number citations in `oracle.md` with named citations](https://github.com/libredb/libredb-studio/pull/563)
- [Did the same for `mongodb.md`](https://github.com/libredb/libredb-studio/pull/581)

## Contributor

### @ucmazmehmet

- [Updated the Windows native support documentation](https://github.com/libredb/libredb-studio/pull/209)

### @sifaaraldevop

- [Made Oracle Thick mode optional and mapped NJS-138 to an honest error](https://github.com/libredb/libredb-studio/pull/229)

### @yangchuansheng

- [Added the Sealos deployment option](https://github.com/libredb/libredb-studio/pull/296)

### @ducminhle

- [Added an HTTPRoute to the Helm chart](https://github.com/libredb/libredb-studio/pull/362)

### @wjiec

- [Used OIDC discovery for generic logout URLs](https://github.com/libredb/libredb-studio/pull/431)

### @Matthew-Selvam

- [Capped chart series and pie slices at the palette size instead of repeating colours](https://github.com/libredb/libredb-studio/pull/501)
- [Stopped schema-diff wrapping non-transactional dialects in `BEGIN;`/`COMMIT;`](https://github.com/libredb/libredb-studio/pull/521)
- [Stopped two concurrent first requests building and initializing two storage providers](https://github.com/libredb/libredb-studio/pull/724)

### @mfatihdayan

- [Updated the provider tri-sync rule to the shipped provider set](https://github.com/libredb/libredb-studio/pull/504)

### @HasselNot7

- [Normalized all text files to LF on checkout](https://github.com/libredb/libredb-studio/pull/555)
- [Matched the `.gitattributes` rules as whole lines in the drift guard](https://github.com/libredb/libredb-studio/pull/562)

### @v01dst

- [Used `@theme inline` so the Geist font variables resolve](https://github.com/libredb/libredb-studio/pull/561)

### @Akimbo92i

- [Made libSQL omit an unknown overview size rather than reporting zero](https://github.com/libredb/libredb-studio/pull/569)

### @cnYui

- [Made MSSQL and Oracle do the same](https://github.com/libredb/libredb-studio/pull/579)

### @dchaudhari7177

- [Re-anchored `mysql.md`'s thirteen code citations to declaration names, and put the file under the guard](https://github.com/libredb/libredb-studio/pull/582)
- [Documented `LOG_LEVEL` with both defaults, and guarded `.env.example` against undocumented `process.env` names](https://github.com/libredb/libredb-studio/pull/583)
- [Documented the bundled Node.js version, artefacts and origin in `SECURITY.md`, and guarded it against drift](https://github.com/libredb/libredb-studio/pull/584)

### @sonalisrisivani

- [Added the undocumented `DatabaseConnection` and `QueryResult` fields to `docs/API_DOCS.md`, and guarded four type blocks](https://github.com/libredb/libredb-studio/pull/580)

### @be-student

- [Replaced the `.ts:N` citations in `AGENT.md`, `FEATURES.md`, `ADDING_A_PROVIDER.md` and `SECURITY.md` with names](https://github.com/libredb/libredb-studio/pull/606)
- [Did the same for `redis.md`, and brought it under the citation guard](https://github.com/libredb/libredb-studio/pull/604)
- [Told an absent MSSQL or Oracle overview size apart from a measured zero](https://github.com/libredb/libredb-studio/pull/601)

### @NormanSMA

- [Added the Spanish README, and registered it with the localized README drift guard](https://github.com/libredb/libredb-studio/pull/605)

### @7487

- [Named `createDatabaseProvider()` in seven provider docs, and stopped the guard passing on nothing](https://github.com/libredb/libredb-studio/pull/629)
- [Replaced `postgres.md`'s stale line-number citations with the names they meant](https://github.com/libredb/libredb-studio/pull/636)
- [Did the same for `clickhouse.md`, where two citations had drifted onto a closing brace](https://github.com/libredb/libredb-studio/pull/639)
- [Did the same for `druid.md`, and credited `quoteUnsafeIntegers()` to the file that declares it](https://github.com/libredb/libredb-studio/pull/645)
- [Did the same for `couchbase.md`, and widened the guard to `.tsx` coordinates too](https://github.com/libredb/libredb-studio/pull/644)
- [Made the create-table form emit each engine's own DDL rather than PostgreSQL's](https://github.com/libredb/libredb-studio/pull/651)
- [Held the duplicated CI-gate paragraph in sync, and dropped `.devcontainer` from the Docker context](https://github.com/libredb/libredb-studio/pull/663)

### @XiaoZ-0218

- [Dropped five docs' references to a `getPlaceholder()` the base class no longer has](https://github.com/libredb/libredb-studio/pull/642)
- [Stopped four docs crediting `SQLBaseProvider` with placeholders that live in `values.ts`](https://github.com/libredb/libredb-studio/pull/650)

### @dvd233

- [Linked `measuredNullableAggregate()` to `measured-aggregate.ts` from the MSSQL and Oracle docs](https://github.com/libredb/libredb-studio/pull/643)

### @SatvikMishra08

- [Added the Helm and subchart-build steps a fresh clone needs before `bun run test`](https://github.com/libredb/libredb-studio/pull/571)

### @saad-works

- [Resolved two static `process.env[...]` bracket shapes so the env docs guard sees them](https://github.com/libredb/libredb-studio/pull/649)
- [Gave the same guard's negative test a control, and matched its comment to the regex](https://github.com/libredb/libredb-studio/pull/652)

### @voidofrgestudio

- [Made MySQL and PostgreSQL omit an unmeasured database size instead of reporting zero bytes](https://github.com/libredb/libredb-studio/pull/627)

### @SyedMuhamadYasir

- [Replaced `sqlite.md`'s stale line-number citations with named ones, and guarded them against returning](https://github.com/libredb/libredb-studio/pull/657)
- [Added a devcontainer with Bun, Helm and 7-Zip, and named CI as the merge gate](https://github.com/libredb/libredb-studio/pull/658)
- [Emitted SQL Server and Oracle migration DDL in their own grammar, not PostgreSQL's](https://github.com/libredb/libredb-studio/pull/659)
- [Made a build mountable under a URL subpath through `BASE_PATH`, cookies and probes included](https://github.com/libredb/libredb-studio/pull/662)

### @macjayz

- [Added the npm package's description, engine keywords, homepage and issue tracker URL](https://github.com/libredb/libredb-studio/pull/697)

### @slsgzs-cloud

- [Added a Create Table action to the empty schema explorer, gated by the engine's capability](https://github.com/libredb/libredb-studio/pull/655)

### @stgomoyaa

- [Required a confirmation before a connection is deleted, on desktop and mobile alike](https://github.com/libredb/libredb-studio/pull/698)

### @mikevillari

- [Stopped short queries in serialized database errors ending in a false ellipsis](https://github.com/libredb/libredb-studio/pull/706)
- [Did the same for the saved-query previews in the command palette](https://github.com/libredb/libredb-studio/pull/707)
- [Ran a component suite the runner never named, and guarded against future omissions](https://github.com/libredb/libredb-studio/pull/711)
- [Removed the desktop header's settings cog, which had hover styling but no action](https://github.com/libredb/libredb-studio/pull/714)
- [Gave six icon-only controls accessible names, including session termination and column removal](https://github.com/libredb/libredb-studio/pull/713)
- [Stopped a qualified table completion inserting the schema twice, and matched the typed qualifier](https://github.com/libredb/libredb-studio/pull/715)
- [Made the launcher print a reachable startup link for wildcard and IPv6 binds](https://github.com/libredb/libredb-studio/pull/709)
- [Quoted PostgreSQL table completions only where `quote_ident` requires it, leaving other dialects unchanged](https://github.com/libredb/libredb-studio/pull/791)

### @CunjieLee

- [Added a Trino session schema field, sent as `X-Trino-Schema` so bare names resolve](https://github.com/libredb/libredb-studio/pull/721)
- [Capped every job in ten workflows with a sized `timeout-minutes`, pinned by a test](https://github.com/libredb/libredb-studio/pull/736)
- [Added a `site.webmanifest` and a 180x180 Apple touch icon so Studio installs to a home screen](https://github.com/libredb/libredb-studio/pull/781)

### @nktnet1

- [Sent `field_multi_value_leniency` so Elasticsearch selects multi-valued fields instead of erroring](https://github.com/libredb/libredb-studio/pull/723)

### @Vetri1706

- [Gave each connection an optional query timeout, and dropped its cached provider on a change](https://github.com/libredb/libredb-studio/pull/752)

### @TonMtt

- [Documented how to rebase a fork branch onto `upstream/main` with `--force-with-lease`](https://github.com/libredb/libredb-studio/pull/735)

### @na12334

- [Added CSV and JSON export to the Data Profiler, masking what the screen masks](https://github.com/libredb/libredb-studio/pull/759)

### @Hashir-Ashraf-Awan

- [Added an optional TOTP second factor to local login, and refused a replayed code](https://github.com/libredb/libredb-studio/pull/779)

### @jabrailkhalil

- [Bound `Cmd/Ctrl+Shift+X` to a new query tab, working while the editor holds focus](https://github.com/libredb/libredb-studio/pull/782)
- [Moved the four keyboard shortcuts into one registry that also generates the docs line](https://github.com/libredb/libredb-studio/pull/803)

### @nightcityblade

- [Repointed two agent comments from a git-ignored design file to a reachable citation](https://github.com/libredb/libredb-studio/pull/793)

### @Abdu11ahBilal

- [Added `README_ur.md` and brought it under the localized README drift guard](https://github.com/libredb/libredb-studio/pull/783)

### @Dharshni-gth

- [Pointed the social preview at `libredb.org` and dropped the engine list from the meta description](https://github.com/libredb/libredb-studio/pull/798)
- [Made inline edits on a default `Query N` tab target the `FROM` clause table](https://github.com/libredb/libredb-studio/pull/924)

### @Swarnabha753

- [Added CSV and JSON export to the pivot table through the shared escaping helpers](https://github.com/libredb/libredb-studio/pull/796)

### @Dharshini-RS03

- [Added a results-grid wrap toggle that re-measures virtualized rows as they grow](https://github.com/libredb/libredb-studio/pull/810)
- [Kept the Run Sel button's blue fill on hover instead of the ghost hover colour](https://github.com/libredb/libredb-studio/pull/838)

### @nycjay

- [Stopped the editor overwriting live keystrokes with its own stale text and moving the caret](https://github.com/libredb/libredb-studio/pull/809)

### @Asgabani

- [Gave a closed query tab an Undo toast that restores it in place](https://github.com/libredb/libredb-studio/pull/818)
- [Added a star toggle that lifts favourite connections into their own sidebar group](https://github.com/libredb/libredb-studio/pull/812)
- [Made sidebar connections reorderable by drag, persisting the order in `connection_order`](https://github.com/libredb/libredb-studio/pull/817)
- [Repinned the CapRover template, cut AI claims the app dropped, and warned about `JWT_SECRET` rotation](https://github.com/libredb/libredb-studio/pull/849)
- [Added a `?` dialog listing every keyboard shortcut from a single registry](https://github.com/libredb/libredb-studio/pull/821)
- [Stopped a connection switch issuing one object-tree read shaped for the previous engine](https://github.com/libredb/libredb-studio/pull/848)

### @InnoxCodes

- [Replaced the flat agent budget figures with the real per-workflow ranges in three READMEs](https://github.com/libredb/libredb-studio/pull/891)
- [Documented that Agent mode's Start needs `STORAGE_PROVIDER` set to `sqlite` or `postgres`](https://github.com/libredb/libredb-studio/pull/890)
- [Added `autoComplete` hints so password managers fill the login email and password](https://github.com/libredb/libredb-studio/pull/896)
- [Pluralized the admin fleet status badge so two failures no longer read `2 error`](https://github.com/libredb/libredb-studio/pull/893)
- [Stopped a long column type squeezing out the column name, with the full type on hover](https://github.com/libredb/libredb-studio/pull/885)
- [Replaced the hardcoded seven engines in the admin empty state with the real catalog count](https://github.com/libredb/libredb-studio/pull/894)
- [Changed the Security tab's all-caps `ENABLED` badges to sentence case](https://github.com/libredb/libredb-studio/pull/929)
- [Made the login submit button read `Sign in`, and pinned it by role in tests](https://github.com/libredb/libredb-studio/pull/932)

### @niukanen1

- [Printed the startup banner URL from the real `HOSTNAME` bind rather than `localhost`](https://github.com/libredb/libredb-studio/pull/847)

### @costajohnt

- [Separated an OIDC misconfiguration from an unreachable issuer, on screen and in the audit log](https://github.com/libredb/libredb-studio/pull/871)

### @iAmAdheil

- [Added `README_hi.md`, linked it from every other README and the drift guard](https://github.com/libredb/libredb-studio/pull/845)

### @0utsights

- [Corrected the Keycloak role mapping: realm roles reach the ID token only when mapped](https://github.com/libredb/libredb-studio/pull/904)

### @Rayan-and-beyond

- [Listed every translated README in the contributing guide's language exception and guard rule](https://github.com/libredb/libredb-studio/pull/903)
- [Corrected the DigitalOcean checklist's health example to the `healthy` status the endpoint returns](https://github.com/libredb/libredb-studio/pull/915)
- [Replaced the UI doc index's dark-only theme claim with the dark-first model](https://github.com/libredb/libredb-studio/pull/911)
- [Documented `LIBREDB_NO_BANNER` for suppressing the startup banner in the Rancher guide](https://github.com/libredb/libredb-studio/pull/912)

### @YaoSong808

- [Closed the Code Generator on an unhandled Escape, and recorded the new global listener](https://github.com/libredb/libredb-studio/pull/892)

### @Mehmetalpertugtekin

- [Pointed the Fly guide's README link at the Environment Variables heading that exists](https://github.com/libredb/libredb-studio/pull/914)

### @DevvoLazza

- [Made the DigitalOcean pin read the published listing version instead of skipping the channel](https://github.com/libredb/libredb-studio/pull/927)
- [Retried the agent ledger's transient Windows chunk probe, keeping each stream's writes ordered](https://github.com/libredb/libredb-studio/pull/925)
- [Asserted the admin preview's category spread by type-id instead of renameable display labels](https://github.com/libredb/libredb-studio/pull/934)

### @xiechimon

- [Wrote the DigitalOcean Droplet env file under `umask 077` and installed it atomically](https://github.com/libredb/libredb-studio/pull/921)

### @Lingikaushikreddy

- [Documented how `TRUST_PROXY_HEADERS` and `TRUSTED_PROXY_HOPS` decide the rate-limit bucket key](https://github.com/libredb/libredb-studio/pull/938)
- [Tabulated the `RATE_LIMIT_*` variables and defaults behind each rate-limit bucket](https://github.com/libredb/libredb-studio/pull/939)

## Getting on this page

Take an issue labelled [good first issue](https://github.com/libredb/libredb-studio/labels/good%20first%20issue) — each one states what "done" looks like as a command you can run yourself, so you never have to ask whether you are finished. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the gates.

Reports count too. If you opened an issue that led to a fix, say so on the pull request that fixed it and we will list the report beside the change.
