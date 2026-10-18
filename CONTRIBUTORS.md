# Contributors

Every change in this repository lands with its tests in the same pull request, under a hard 100% line-coverage gate and every check `main` requires. That is an unusual bar for a project this size, and it means a merged pull request here is evidence about the person who wrote it, not only about the project.

So this is not a thank-you wall. Each entry links to the change itself, so a reader who does not know us can check the claim. If your name is here, the link is yours to use — a CV, a profile README, anywhere the question "what have you actually shipped" comes up.

Nothing here is counted. Not merged pull requests, not changed lines, not closed issues. A count sees how often somebody showed up and misses everything that matters about it: the care taken, the bug nobody else found, the answer written out for a stranger. So the rungs below are judgements rather than totals, and where one is not obvious the reason is written beside the name — [CONTRIBUTING.md](CONTRIBUTING.md#the-contributor-ladder) says what each rung means.

Everyone whose work is in `main` is here, maintainers included. Bots and coding agents are not — `dependabot`, `Copilot` and `claude` all appear in the repository's commit history and none of them is a person, so listing them beside people would blur the only thing this page is for. `git shortlog -sn` shows the whole history including theirs. Accounts the organisation has blocked are not listed either.

Within each rung, people are in the order they first landed a change.

Every entry ends with a link to all of that person's merged pull requests, so it is never out of date. Where someone has landed more than two changes, the links above it are a sample.

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
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aharish18092002)

### @omerfarukbolat

The light theme rests on the shared token layer he built, and the export path escapes every field because of the pass he did over it. Both were the kind of change that moves the floor under everything else rather than fixing one thing.

- [Fixed the auth flow, middleware redirects and hooks cleanup](https://github.com/libredb/libredb-studio/pull/10)
- [Enforced the ESLint and TypeScript checks in CI, and fixed the component bugs they found](https://github.com/libredb/libredb-studio/pull/18)
- [Built a light theme through a shared token layer, and fixed four silent query-execution defects](https://github.com/libredb/libredb-studio/pull/384)
- [Escaped every field an export writes, and stopped a plan outliving its run](https://github.com/libredb/libredb-studio/pull/422)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aomerfarukbolat)

### @suleymansurucu

Came the same day as the first, hours behind it, into the same empty repository. Two people decided this was worth their evening before there was anything here to promise them it would be.

- [Handled SQL queries in the demo connection, with a mock fallback](https://github.com/libredb/libredb-studio/commit/c6d3e10c5d5076f674af12f58d2244e0208e6c5b)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asuleymansurucu)

### @hbasria

Brought a fifth identity provider into the OIDC layer, and the branch he added is still what runs — `src/lib/oidc.ts` handles Zitadel's RP-initiated logout because of him. He arrived with the doc and the test in the same change, months before this repository wrote that down as a rule.

- [Added Zitadel OIDC integration support](https://github.com/libredb/libredb-studio/commit/d8227cbc)
- [Covered `OIDC_ROLE_CLAIM` in the Zitadel logout URL test](https://github.com/libredb/libredb-studio/commit/09d36a4d)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ahbasria)

### @ugurpektas

Built out the admin section: the routes, the interactive UI around them, and the tests that hold it. He did it in one careful pass rather than leaving it half-finished for someone else.

- [Added the admin section routes and polished the interactive UI](https://github.com/libredb/libredb-studio/pull/231)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Augurpektas)

### @koraysrn

First into the agent layer, which nobody outside the core team had opened, and he has stayed in it since: its drive ownership, its PostgreSQL grounding and the history of finished runs are all partly his. He started in the part nobody volunteers for, a run behaving correctly when something goes wrong.

- [Enforced single-drive ownership in the agent, and refused post-close appends](https://github.com/libredb/libredb-studio/pull/419)
- [Aggregated the PostgreSQL grounding column read per table](https://github.com/libredb/libredb-studio/pull/537)
- [Kept the engine's own and extension-owned objects out of PostgreSQL agent grounding](https://github.com/libredb/libredb-studio/pull/625)
- [Added a History list of finished agent conversations, reopened from each run's own ledger](https://github.com/libredb/libredb-studio/pull/830)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Akoraysrn)

### @hasnaintypes

Went wherever the work was: the login page, the admin fleet view, a license notice nobody had stated, and the provider docs whose citations had quietly rotted. Each one arrived finished, with the reasoning written down.

- [Closed the login hero's overflow at 1280x800](https://github.com/libredb/libredb-studio/pull/550)
- [Stated elkjs's EPL-2.0 license alongside the MIT license](https://github.com/libredb/libredb-studio/pull/552)
- [Summed the fleet's own byte figure instead of re-parsing display strings](https://github.com/libredb/libredb-studio/pull/551)
- [Replaced the stale line-number citations in `oracle.md` with named citations](https://github.com/libredb/libredb-studio/pull/563)
- [Did the same for `mongodb.md`](https://github.com/libredb/libredb-studio/pull/581)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ahasnaintypes)

## Contributor

### @ucmazmehmet

- [Updated the Windows native support documentation](https://github.com/libredb/libredb-studio/pull/209)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aucmazmehmet)

### @sifaaraldevop

- [Made Oracle Thick mode optional and mapped NJS-138 to an honest error](https://github.com/libredb/libredb-studio/pull/229)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asifaaraldevop)

### @yangchuansheng

- [Added the Sealos deployment option](https://github.com/libredb/libredb-studio/pull/296)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ayangchuansheng)

### @ducminhle

- [Added an HTTPRoute to the Helm chart](https://github.com/libredb/libredb-studio/pull/362)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aducminhle)

### @wjiec

- [Used OIDC discovery for generic logout URLs](https://github.com/libredb/libredb-studio/pull/431)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Awjiec)

### @Matthew-Selvam

- [Capped chart series and pie slices at the palette size instead of repeating colours](https://github.com/libredb/libredb-studio/pull/501)
- [Stopped two concurrent first requests building and initializing two storage providers](https://github.com/libredb/libredb-studio/pull/724)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AMatthew-Selvam)

### @mfatihdayan

- [Updated the provider tri-sync rule to the shipped provider set](https://github.com/libredb/libredb-studio/pull/504)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Amfatihdayan)

### @HasselNot7

- [Normalized all text files to LF on checkout](https://github.com/libredb/libredb-studio/pull/555)
- [Matched the `.gitattributes` rules as whole lines in the drift guard](https://github.com/libredb/libredb-studio/pull/562)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AHasselNot7)

### @v01dst

- [Used `@theme inline` so the Geist font variables resolve](https://github.com/libredb/libredb-studio/pull/561)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Av01dst)

### @Akimbo92i

- [Made libSQL omit an unknown overview size rather than reporting zero](https://github.com/libredb/libredb-studio/pull/569)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AAkimbo92i)

### @cnYui

- [Made MSSQL and Oracle do the same](https://github.com/libredb/libredb-studio/pull/579)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AcnYui)

### @dchaudhari7177

- [Re-anchored `mysql.md`'s thirteen code citations to declaration names, and put the file under the guard](https://github.com/libredb/libredb-studio/pull/582)
- [Documented the bundled Node.js version, artefacts and origin in `SECURITY.md`, and guarded it against drift](https://github.com/libredb/libredb-studio/pull/584)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Adchaudhari7177)

### @sonalisrisivani

- [Added the undocumented `DatabaseConnection` and `QueryResult` fields to `docs/API_DOCS.md`, and guarded four type blocks](https://github.com/libredb/libredb-studio/pull/580)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asonalisrisivani)

### @be-student

- [Replaced the `.ts:N` citations in `AGENT.md`, `FEATURES.md`, `ADDING_A_PROVIDER.md` and `SECURITY.md` with names](https://github.com/libredb/libredb-studio/pull/606)
- [Told an absent MSSQL or Oracle overview size apart from a measured zero](https://github.com/libredb/libredb-studio/pull/601)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Abe-student)

### @NormanSMA

- [Added the Spanish README, and registered it with the localized README drift guard](https://github.com/libredb/libredb-studio/pull/605)
- [Added the `libredb-studio-bin` AUR package](https://github.com/libredb/libredb-studio/pull/1218)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ANormanSMA)

### @7487

- [Named `createDatabaseProvider()` in seven provider docs, and stopped the guard passing on nothing](https://github.com/libredb/libredb-studio/pull/629)
- [Made the create-table form emit each engine's own DDL rather than PostgreSQL's](https://github.com/libredb/libredb-studio/pull/651)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3A7487)

### @XiaoZ-0218

- [Dropped five docs' references to a `getPlaceholder()` the base class no longer has](https://github.com/libredb/libredb-studio/pull/642)
- [Stopped four docs crediting `SQLBaseProvider` with placeholders that live in `values.ts`](https://github.com/libredb/libredb-studio/pull/650)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AXiaoZ-0218)

### @dvd233

- [Linked `measuredNullableAggregate()` to `measured-aggregate.ts` from the MSSQL and Oracle docs](https://github.com/libredb/libredb-studio/pull/643)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Advd233)

### @SatvikMishra08

- [Added the Helm and subchart-build steps a fresh clone needs before `bun run test`](https://github.com/libredb/libredb-studio/pull/571)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ASatvikMishra08)

### @saad-works

- [Resolved two static `process.env[...]` bracket shapes so the env docs guard sees them](https://github.com/libredb/libredb-studio/pull/649)
- [Counted MySQL indexes per table, not by name alone, in Monitoring Overview](https://github.com/libredb/libredb-studio/pull/1537)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asaad-works)

### @voidofrgestudio

- [Made MySQL and PostgreSQL omit an unmeasured database size instead of reporting zero bytes](https://github.com/libredb/libredb-studio/pull/627)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Avoidofrgestudio)

### @SyedMuhamadYasir

- [Emitted SQL Server and Oracle migration DDL in their own grammar, not PostgreSQL's](https://github.com/libredb/libredb-studio/pull/659)
- [Made a build mountable under a URL subpath through `BASE_PATH`, cookies and probes included](https://github.com/libredb/libredb-studio/pull/662)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ASyedMuhamadYasir)

### @macjayz

- [Added the npm package's description, engine keywords, homepage and issue tracker URL](https://github.com/libredb/libredb-studio/pull/697)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Amacjayz)

### @slsgzs-cloud

- [Added a Create Table action to the empty schema explorer, gated by the engine's capability](https://github.com/libredb/libredb-studio/pull/655)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aslsgzs-cloud)

### @stgomoyaa

- [Required a confirmation before a connection is deleted, on desktop and mobile alike](https://github.com/libredb/libredb-studio/pull/698)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Astgomoyaa)

### @mikevillari

- [Gave six icon-only controls accessible names, including session termination and column removal](https://github.com/libredb/libredb-studio/pull/713)
- [Made the launcher print a reachable startup link for wildcard and IPv6 binds](https://github.com/libredb/libredb-studio/pull/709)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Amikevillari)

### @CunjieLee

- [Added a Trino session schema field, sent as `X-Trino-Schema` so bare names resolve](https://github.com/libredb/libredb-studio/pull/721)
- [Added a `site.webmanifest` and a 180x180 Apple touch icon so Studio installs to a home screen](https://github.com/libredb/libredb-studio/pull/781)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ACunjieLee)

### @nktnet1

- [Sent `field_multi_value_leniency` so Elasticsearch selects multi-valued fields instead of erroring](https://github.com/libredb/libredb-studio/pull/723)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Anktnet1)

### @Vetri1706

- [Gave each connection an optional query timeout, and dropped its cached provider on a change](https://github.com/libredb/libredb-studio/pull/752)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AVetri1706)

### @TonMtt

- [Documented how to rebase a fork branch onto `upstream/main` with `--force-with-lease`](https://github.com/libredb/libredb-studio/pull/735)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ATonMtt)

### @na12334

- [Added CSV and JSON export to the Data Profiler, masking what the screen masks](https://github.com/libredb/libredb-studio/pull/759)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ana12334)

### @Hashir-Ashraf-Awan

- [Added an optional TOTP second factor to local login, and refused a replayed code](https://github.com/libredb/libredb-studio/pull/779)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AHashir-Ashraf-Awan)

### @jabrailkhalil

- [Bound `Cmd/Ctrl+Shift+X` to a new query tab, working while the editor holds focus](https://github.com/libredb/libredb-studio/pull/782)
- [Moved the four keyboard shortcuts into one registry that also generates the docs line](https://github.com/libredb/libredb-studio/pull/803)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ajabrailkhalil)

### @nightcityblade

- [Repointed two agent comments from a git-ignored design file to a reachable citation](https://github.com/libredb/libredb-studio/pull/793)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Anightcityblade)

### @Abdu11ahBilal

- [Added `README_ur.md` and brought it under the localized README drift guard](https://github.com/libredb/libredb-studio/pull/783)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AAbdu11ahBilal)

### @Dharshni-gth

- [Pointed the social preview at `libredb.org` and dropped the engine list from the meta description](https://github.com/libredb/libredb-studio/pull/798)
- [Made inline edits on a default `Query N` tab target the `FROM` clause table](https://github.com/libredb/libredb-studio/pull/924)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ADharshni-gth)

### @Swarnabha753

- [Added CSV and JSON export to the pivot table through the shared escaping helpers](https://github.com/libredb/libredb-studio/pull/796)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ASwarnabha753)

### @Dharshini-RS03

- [Added a results-grid wrap toggle that re-measures virtualized rows as they grow](https://github.com/libredb/libredb-studio/pull/810)
- [Built the object reads with `jsonb` on every engine, so a RisingWave table shows its columns](https://github.com/libredb/libredb-studio/pull/1096)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ADharshini-RS03)

### @nycjay

- [Stopped the editor overwriting live keystrokes with its own stale text and moving the caret](https://github.com/libredb/libredb-studio/pull/809)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Anycjay)

### @Asgabani

- [Gave a closed query tab an Undo toast that restores it in place](https://github.com/libredb/libredb-studio/pull/818)
- [Made sidebar connections reorderable by drag, persisting the order in `connection_order`](https://github.com/libredb/libredb-studio/pull/817)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AAsgabani)

### @InnoxCodes

- [Added `autoComplete` hints so password managers fill the login email and password](https://github.com/libredb/libredb-studio/pull/896)
- [Stopped a long column type squeezing out the column name, with the full type on hover](https://github.com/libredb/libredb-studio/pull/885)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AInnoxCodes)

### @niukanen1

- [Fixed a `font-mediumr` typo that left 35 labels at the wrong weight, and guarded it](https://github.com/libredb/libredb-studio/pull/1140)
- [Bounded the MongoDB connect by the request's query timeout](https://github.com/libredb/libredb-studio/pull/1591)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aniukanen1)

### @costajohnt

- [Separated an OIDC misconfiguration from an unreachable issuer, on screen and in the audit log](https://github.com/libredb/libredb-studio/pull/871)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Acostajohnt)

### @iAmAdheil

- [Added `README_hi.md`, linked it from every other README and the drift guard](https://github.com/libredb/libredb-studio/pull/845)
- [Reported an Oracle column's declared type rather than `DATA_TYPE` alone](https://github.com/libredb/libredb-studio/pull/1187)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AiAmAdheil)

### @0utsights

- [Corrected the Keycloak role mapping: realm roles reach the ID token only when mapped](https://github.com/libredb/libredb-studio/pull/904)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3A0utsights)

### @YaoSong808

- [Closed the Code Generator on an unhandled Escape, and recorded the new global listener](https://github.com/libredb/libredb-studio/pull/892)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AYaoSong808)

### @Mehmetalpertugtekin

- [Pointed the Fly guide's README link at the Environment Variables heading that exists](https://github.com/libredb/libredb-studio/pull/914)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AMehmetalpertugtekin)

### @DevvoLazza

- [Retried the agent ledger's transient Windows chunk probe, keeping each stream's writes ordered](https://github.com/libredb/libredb-studio/pull/925)
- [Guarded the destinations of HTTP database connections](https://github.com/libredb/libredb-studio/pull/1114)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ADevvoLazza)

### @xiechimon

- [Wrote the DigitalOcean Droplet env file under `umask 077` and installed it atomically](https://github.com/libredb/libredb-studio/pull/921)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Axiechimon)

### @Lingikaushikreddy

- [Documented how `TRUST_PROXY_HEADERS` and `TRUSTED_PROXY_HOPS` decide the rate-limit bucket key](https://github.com/libredb/libredb-studio/pull/938)
- [Added a one-command Keycloak OIDC demo stack](https://github.com/libredb/libredb-studio/pull/947)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ALingikaushikreddy)

### @Anikesh348

- [Gave the schema explorer's icon-only table actions button a table-specific accessible name](https://github.com/libredb/libredb-studio/pull/886)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AAnikesh348)

### @tunglambk

- [Resolved seed connection credentials from HashiCorp Vault, so a rotated secret needs no restart](https://github.com/libredb/libredb-studio/pull/944)
- [Bounded MongoDB server selection above the failover window, so a closed port fails in half a minute](https://github.com/libredb/libredb-studio/pull/1518)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Atunglambk)

### @nawazish2

- [Added Elasticsearch API key authentication, preferred over Basic auth when both halves are set](https://github.com/libredb/libredb-studio/pull/994)
- [Grouped sidebar connections in collapsible sections the user defines](https://github.com/libredb/libredb-studio/pull/1229)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Anawazish2)

### @JavierparraDev

- [Printed the schema beside each table on the admin Operations page, so same-named tables are told apart](https://github.com/libredb/libredb-studio/pull/984)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AJavierparraDev)

### @linropx

- [Refused a committed `.only` before the test run, instead of letting the skipped tests pass green](https://github.com/libredb/libredb-studio/pull/987)
- [Stopped the launcher binding the machine name or container id that arrives as `HOSTNAME`](https://github.com/libredb/libredb-studio/pull/1053)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Alinropx)

### @sloemo01

- [Read the SQLite object kinds from the provider in the agent guard, instead of scraping source text](https://github.com/libredb/libredb-studio/pull/986)
- [Made a failed Oracle connect close the pool it created](https://github.com/libredb/libredb-studio/pull/1105)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asloemo01)

### @KodYazicam

- [Made agent mode execute on MySQL and MariaDB, behind a privilege check and a read-only transaction](https://github.com/libredb/libredb-studio/pull/1629)
- [Made agent mode execute on MongoDB, refusing any user that holds more than read privileges](https://github.com/libredb/libredb-studio/pull/1790)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AKodYazicam)

### @t957095

- [Added the missing PostgreSQL Clients link to the Japanese, Spanish, Urdu and Hindi READMEs](https://github.com/libredb/libredb-studio/pull/1012)
- [Proofread `README_zh.md` as a native speaker, and rewrote its stale transport-security note](https://github.com/libredb/libredb-studio/pull/1005)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3At957095)

### @NotAFlightRisk

- [Repointed the Kubero guide's dead install link at a page that exists](https://github.com/libredb/libredb-studio/pull/1021)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ANotAFlightRisk)

### @chiliec

- [Stopped schema diff writing `DEFAULT` before ClickHouse `MATERIALIZED`, `ALIAS` and `EPHEMERAL` columns](https://github.com/libredb/libredb-studio/pull/1035)
- [Held Trino `nextUri` links to the connection's own origin, so its credentials are never sent elsewhere](https://github.com/libredb/libredb-studio/pull/1090)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Achiliec)

### @rahimahisah17

- [Mounted the `postgres:18` data volume at `/var/lib/postgresql`, ending a restart loop](https://github.com/libredb/libredb-studio/pull/1041)
- [Moved Next.js to the release that fixes a critical security vulnerability](https://github.com/libredb/libredb-studio/pull/1288)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Arahimahisah17)

### @bernalalexis-try

- [Showed an empty-string default in the ER diagram's column tooltip instead of hiding it](https://github.com/libredb/libredb-studio/pull/1036)
- [Read SQLite, libSQL and DuckDB column defaults as values rather than quoted catalog text](https://github.com/libredb/libredb-studio/pull/1048)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Abernalalexis-try)

### @saitakarcesme

- [Corrected the local and hosted model counts in the LLM setup guide](https://github.com/libredb/libredb-studio/pull/1060)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asaitakarcesme)

### @BladeRunner-KD6-37

- [Corrected the agent API path and handler counts in `API_DOCS.md`](https://github.com/libredb/libredb-studio/pull/1063)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ABladeRunner-KD6-37)

### @lg114

- [Expanded the Chinese README with the install channels, the feature set and the agent](https://github.com/libredb/libredb-studio/pull/1052)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Alg114)

### @Ehtasham-Yasin

- [Added Copy Cell and Copy Row as JSON to the results grid context menu, keeping masked values masked](https://github.com/libredb/libredb-studio/pull/1068)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AEhtasham-Yasin)

### @Aditya-XR

- [Refused Redis commands such as `SELECT` and `AUTH` that would move the connection every request shares](https://github.com/libredb/libredb-studio/pull/1121)
- [Read SQL Server `DATETIME` and `SMALLDATETIME` as the engine's own text, and exported them so they replay](https://github.com/libredb/libredb-studio/pull/1639)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AAditya-XR)

### @NikharAsthana

- [Pinned the Schema Diff migration copy button with a clipboard test](https://github.com/libredb/libredb-studio/pull/1076)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ANikharAsthana)

### @igorwfaoro

- [Made the admin Overview's Recent Activity state what it covers, with a path to the Audit tab](https://github.com/libredb/libredb-studio/pull/1079)
- [Sized each result grid column from its header instead of one fixed width](https://github.com/libredb/libredb-studio/pull/1113)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aigorwfaoro)

### @Xavees

- [Added the capabilities, error-handling and usage sections `duckdb.md` was missing](https://github.com/libredb/libredb-studio/pull/1103)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AXavees)

### @yizhixiaokong

- [Added a resumable walk of an engine's own key space, and the sidebar key browser that drives it](https://github.com/libredb/libredb-studio/pull/1095)
- [Guarded the sidebar's deferred catalog against a deferred walk](https://github.com/libredb/libredb-studio/pull/1616)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ayizhixiaokong)

### @MohamedIdhries

- [Covered a long-form IPv6 Trino host against a short `nextUri` in the transport tests](https://github.com/libredb/libredb-studio/pull/1093)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AMohamedIdhries)

### @TehmeenaAkhtar

- [Made the Urdu README read more naturally, and kept the link to its renamed install heading working](https://github.com/libredb/libredb-studio/pull/1118)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ATehmeenaAkhtar)

### @Roberton003

- [Started the read-only MCP server at `/api/mcp`, which the maintainers then rebuilt on the official SDK](https://github.com/libredb/libredb-studio/pull/1070)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ARoberton003)

### @Reitzzz

- [Reported a PostgreSQL `statement_timeout` as a timeout instead of a user cancel](https://github.com/libredb/libredb-studio/pull/1149)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AReitzzz)

### @fatihcvs

- [Replaced line-number citations in source comments with the declaration names they meant](https://github.com/libredb/libredb-studio/pull/1141)
- [Stopped a short result page showing a `limited` badge when nothing was cut](https://github.com/libredb/libredb-studio/pull/1142)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Afatihcvs)

### @MFA-G

- [Reset TLS, SSH, environment and Advanced fields when a new connection's dialog closes](https://github.com/libredb/libredb-studio/pull/1150)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AMFA-G)

### @muskanbandta23

- [Added ZopDay to the README's one-click deploy options](https://github.com/libredb/libredb-studio/pull/1183)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Amuskanbandta23)

### @Retsumdk

- [Derived the provider docs' named citations inside the guard test instead of trusting a hand-kept list](https://github.com/libredb/libredb-studio/pull/1194)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ARetsumdk)

### @shivamcoderrrr

- [Moved the query safety dialog onto the Radix alert dialog, for focus trapping and keyboard use](https://github.com/libredb/libredb-studio/pull/1191)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ashivamcoderrrr)

### @paulocoutinhox

- [Added the Portuguese README, linked it from the others and registered it with the drift guard](https://github.com/libredb/libredb-studio/pull/1017)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Apaulocoutinhox)

### @Fristail27

- [Added the Russian README, linked it from the others and registered it with the drift guard](https://github.com/libredb/libredb-studio/pull/1188)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AFristail27)

### @switchcasestudio

- [Kept the confirmation dialogs' Cancel button on the studio theme's colour when the OS is dark](https://github.com/libredb/libredb-studio/pull/1202)
- [Counted ER diagram relations by kind, so a view is not called a table](https://github.com/libredb/libredb-studio/pull/1508)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aswitchcasestudio)

### @ArthurRamonSouza

- [Reworded the Apache Kafka row of the Portuguese README](https://github.com/libredb/libredb-studio/pull/1206)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AArthurRamonSouza)

### @abkucuk

- [Dropped the `tcp:` prefix from a pasted ADO.NET `Server`, so an Azure connection string connects](https://github.com/libredb/libredb-studio/pull/1212)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aabkucuk)

### @Maaz2212

- [Bounded the schema context sent to the AI, and handled a context overflow error](https://github.com/libredb/libredb-studio/pull/1579)
- [Left fields the SQL engine cannot project out of generated Elasticsearch and OpenSearch queries](https://github.com/libredb/libredb-studio/pull/1671)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AMaaz2212)

### @JaredAung

- [Recorded the Scoop Extras listing in the channel inventory and the install docs](https://github.com/libredb/libredb-studio/pull/1226)
- [Parsed Redis `INFO` into metrics shown on the Operations tab, instead of a line count](https://github.com/libredb/libredb-studio/pull/1608)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AJaredAung)

### @gurkanceylan41

- [Fixed the in-page links in `mssql.md` and `redis.md` that missed their headings](https://github.com/libredb/libredb-studio/pull/1234)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Agurkanceylan41)

### @rivolity

- [Made the Vault Kubernetes auth mount configurable through `VAULT_K8S_AUTH_PATH`](https://github.com/libredb/libredb-studio/pull/1282)
- [Added `extraVolumes`, `extraVolumeMounts` and `extraObjects` to the Helm chart](https://github.com/libredb/libredb-studio/pull/1605)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Arivolity)

### @berkay-byte

- [Corrected the `vacuumAction` provider count, and dropped a stale `reindex` reference](https://github.com/libredb/libredb-studio/pull/1280)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aberkay-byte)

### @lb1192176991-lab

- [Documented the `*_PATH`, `*_DIR` and `*_FILE` env classification rule in `CONTRIBUTING.md`](https://github.com/libredb/libredb-studio/pull/1298)
- [Trimmed whitespace from `VAULT_K8S_TOKEN_PATH` and `VAULT_K8S_AUTH_PATH`](https://github.com/libredb/libredb-studio/pull/1297)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Alb1192176991-lab)

### @lui01212

- [Corrected the X5 backlog entry's rendering notes after the modal extraction](https://github.com/libredb/libredb-studio/pull/1300)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Alui01212)

### @cestercian

- [Hid engine-owned schemas on wire-compatible engines](https://github.com/libredb/libredb-studio/pull/1598)
- [Accepted ScyllaDB's view type as a materialized view source](https://github.com/libredb/libredb-studio/pull/1618)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Acestercian)

### @rnihesh

- [Fixed the Db2 doc's statement terminator row, and filled the gaps it had against the code](https://github.com/libredb/libredb-studio/pull/1314)
- [Cleared the previous run's error when a new run starts](https://github.com/libredb/libredb-studio/pull/1316)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Arnihesh)

### @mgr-punith

- [Corrected the non-SQL query formats intro in `DATABASE_PROVIDERS.md`, and added LibreDB to it](https://github.com/libredb/libredb-studio/pull/1319)
- [Removed stale engine counts from the login page test comments](https://github.com/libredb/libredb-studio/pull/1465)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Amgr-punith)

### @DevKhizerer

- [Replaced a stale type-id count in a schema statistics comment with the rule behind it](https://github.com/libredb/libredb-studio/pull/1360)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ADevKhizerer)

### @hridhinvarkeyjoseph

- [Retried MongoDB `listDatabases` without `authorizedDatabases` on FerretDB, which refuses the field](https://github.com/libredb/libredb-studio/pull/1302)
- [Refused every unicode escape in a quoted Cypher name](https://github.com/libredb/libredb-studio/pull/1545)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ahridhinvarkeyjoseph)

### @stroexd

- [Read PostgreSQL `interval`, `point` and a JSON null as the engine's own text](https://github.com/libredb/libredb-studio/pull/1503)
- [Read table rows from `pg_class` where `pg_stat_user_tables` is empty, so CockroachDB shows its tables](https://github.com/libredb/libredb-studio/pull/1548)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Astroexd)

### @brown-sussy

- [Resolved the Couchbase bucket from the connection string's path](https://github.com/libredb/libredb-studio/pull/1517)
- [Kept connection names visible beside the read-only badge](https://github.com/libredb/libredb-studio/pull/1544)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Abrown-sussy)

### @Jeevan2410

- [Named the refusal and the address when ClickHouse, Druid, libSQL or Couchbase cannot be reached](https://github.com/libredb/libredb-studio/pull/1571)
- [Measured the MySQL EXPLAIN grammar against a table when `SELECT 1` is refused](https://github.com/libredb/libredb-studio/pull/1609)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AJeevan2410)

### @abinash2553J

- [Kept nested paths in MongoDB generated test data](https://github.com/libredb/libredb-studio/pull/1555)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aabinash2553J)

### @irfanfaraaz

- [Hid routines and relations an extension put in a user schema](https://github.com/libredb/libredb-studio/pull/1597)
- [Offered Terminate in Monitoring only where the server accepts a kill](https://github.com/libredb/libredb-studio/pull/1625)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Airfanfaraaz)

### @SrikanthBonkuri

- [Kept column types as written in the ER diagram, and told relation kinds apart](https://github.com/libredb/libredb-studio/pull/1559)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ASrikanthBonkuri)

### @itz-puneet

- [Withheld per-row maintenance controls on a read-only connection](https://github.com/libredb/libredb-studio/pull/1611)
- [Turned on RisingWave's implicit flush, so an edit is read back](https://github.com/libredb/libredb-studio/pull/1626)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aitz-puneet)

### @bizimarda

- [Counted only base tables in the PostgreSQL Overview, matching the tree](https://github.com/libredb/libredb-studio/pull/1615)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Abizimarda)

### @jihyunK0617

- [Added the Korean README, and registered it with the localized README drift guard](https://github.com/libredb/libredb-studio/pull/1524)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AjihyunK0617)

### @siddxwar04

- [Left foreign keys out of generated test data, and kept unique values distinct](https://github.com/libredb/libredb-studio/pull/1610)
- [Wrote a BC date in an Oracle INSERT export with its sign](https://github.com/libredb/libredb-studio/pull/1674)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asiddxwar04)

### @HannaSalinas

- [Dropped two stale provider counts from `postgres.md`](https://github.com/libredb/libredb-studio/pull/1622)
- [Brought the Spanish README's transport security paragraph and Db2 LUW row up to date](https://github.com/libredb/libredb-studio/pull/1662)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AHannaSalinas)

### @junaidaliruk

- [Dropped two engine counts that no longer held from Druid comments](https://github.com/libredb/libredb-studio/pull/1647)
- [Reworded a MongoDB comment that claimed the only per-object read](https://github.com/libredb/libredb-studio/pull/1644)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ajunaidaliruk)

### @navpreet-dev

- [Pointed `ARCHITECTURE.md` at `ADDING_A_PROVIDER.md` and `.env.example`](https://github.com/libredb/libredb-studio/pull/1655)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Anavpreet-dev)

### @Furox-Art

- [Added the missing libSQL row to the local test database table](https://github.com/libredb/libredb-studio/pull/1637)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AFurox-Art)

### @ShahabAhmed01

- [Made Test Connection refuse a missing Couchbase bucket and warn about a missing Trino catalog](https://github.com/libredb/libredb-studio/pull/1628)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AShahabAhmed01)

### @Dariusch

- [Added the Google BigQuery provider over the REST API, with no Google SDK](https://github.com/libredb/libredb-studio/pull/1672)
- [Made SQL completion read the clause and the scope it is in](https://github.com/libredb/libredb-studio/pull/1700)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ADariusch)

### @Totopo27

- [Stopped SQL Server table stats multiplying row counts by indexes and allocation units](https://github.com/libredb/libredb-studio/pull/1682)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ATotopo27)

### @samusagbt

- [Replaced two stale provider counts in the object route's comments](https://github.com/libredb/libredb-studio/pull/1716)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asamusagbt)

### @CodeByPeace

- [Replaced stale provider counts in `mongodb.md` with wording that needs no number](https://github.com/libredb/libredb-studio/pull/1675)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ACodeByPeace)

### @notlakshitha

- [Fixed the README's BrowserStack open-source link](https://github.com/libredb/libredb-studio/pull/1739)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Anotlakshitha)

### @Vardhan2006

- [Added a live PostgreSQL check of the agent's read-only profile to the functional smoke test](https://github.com/libredb/libredb-studio/pull/1648)
- [Added Db2 LUW to the Rancher inline editing list](https://github.com/libredb/libredb-studio/pull/1741)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AVardhan2006)

### @kkj-buildstr

- [Let one PostgreSQL connection browse every database the role can connect to](https://github.com/libredb/libredb-studio/pull/1649)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Akkj-buildstr)

### @Jah-yee

- [Listed passkey sign-in among the routes that need no session in `SECURITY.md`](https://github.com/libredb/libredb-studio/pull/1757)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AJah-yee)

### @0x0000x

- [Stopped the README listing the integration-tested providers by name](https://github.com/libredb/libredb-studio/pull/1760)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3A0x0000x)

### @sadhana-s-codez

- [Corrected the image tags table in `DOCKERHUB.md` to match the publishing workflow](https://github.com/libredb/libredb-studio/pull/1765)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asadhana-s-codez)

### @SwatiManjari

- [Documented the query language values and three missing `ProviderLabels` fields](https://github.com/libredb/libredb-studio/pull/1763)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3ASwatiManjari)

### @daemon-tech

- [Dropped stale `getSchema()` references from the Redis provider comments](https://github.com/libredb/libredb-studio/pull/1758)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Adaemon-tech)

### @evgessshkin

- [Counted the WAL in the SQLite and DuckDB database size](https://github.com/libredb/libredb-studio/pull/1673)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Aevgessshkin)

### @Fineturkey

- [Corrected the README drift guard's comments on the files and invariants it checks](https://github.com/libredb/libredb-studio/pull/1776)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AFineturkey)

### @KrishanKumarAwasthi

- [Stopped a drive token comment counting the proxy's public paths](https://github.com/libredb/libredb-studio/pull/1767)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AKrishanKumarAwasthi)

### @sadfun

- [Added Pethost to the README's one-click deploy options](https://github.com/libredb/libredb-studio/pull/1780)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Asadfun)

### @T-Zaid

- [Refused a Kafka classic group with a member the client cannot decode, instead of showing it partial](https://github.com/libredb/libredb-studio/pull/1788)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3AT-Zaid)

### @yash8233

- [Fixed the provider count in the toolchain guide](https://github.com/libredb/libredb-studio/pull/1782)
- [All merged pull requests](https://github.com/libredb/libredb-studio/pulls?q=is%3Apr+is%3Amerged+author%3Ayash8233)

## Getting on this page

Take an issue labelled [good first issue](https://github.com/libredb/libredb-studio/labels/good%20first%20issue) — each one states what "done" looks like as a command you can run yourself, so you never have to ask whether you are finished. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the gates.

Reports count too. If you opened an issue that led to a fix, say so on the pull request that fixed it and we will list the report beside the change.
