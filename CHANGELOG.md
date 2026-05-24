## [1.5.1](https://github.com/Mearman/tau/compare/v1.5.0...v1.5.1) (2026-05-24)

### Bug Fixes

* clean up terminal jobs from backgroundJobs map ([8ab6a7a](https://github.com/Mearman/tau/commit/8ab6a7a4da6bbd1c64954e45641aae7c7ba9253e))

## [1.5.0](https://github.com/Mearman/tau/compare/v1.4.5...v1.5.0) (2026-05-23)

### Features

* add /context command for token usage visualisation ([8abd2aa](https://github.com/Mearman/tau/commit/8abd2aaf31b6ec7b127c5c965f34e6520642b2c0))
* add Chrome extension, native bridge, and web browse implementation ([1aed7f1](https://github.com/Mearman/tau/commit/1aed7f1847b9ca3171e17d3b2df327061f9c02ee))
* add context files and skills as separate categories to /context ([25b8158](https://github.com/Mearman/tau/commit/25b8158fe46cf43c8e3ea58c1676accef3d7afc4))
* add reload tool for model-initiated configuration reload ([50b0ce0](https://github.com/Mearman/tau/commit/50b0ce0a82f8ca57309fc1c1e2653590b0f777be))
* add web browse tools (chrome_list, web_browse, web_screenshot, web_interact) ([abe850e](https://github.com/Mearman/tau/commit/abe850ea336af2f01d77557e6e9cc2485afdc084))
* background agent tool with context continuity (phase 4) ([4466441](https://github.com/Mearman/tau/commit/44664413b847f76d0e2d320691ed1f0925dbfcae))
* file-first output + promise-race backgrounding (phase 1) ([ee22d08](https://github.com/Mearman/tau/commit/ee22d08b33e510338a26573d1c5577ff4f0ae53c))
* foreground task registry with visual indicators (phase 2) ([de83b1a](https://github.com/Mearman/tau/commit/de83b1ae94cd169243b036bd73c9310e48dd3127))
* improve grid rendering with half-blocks and progress bar ([3c1c05d](https://github.com/Mearman/tau/commit/3c1c05dd5a5990acec83de16d2358f1679702e46))
* infer loop interval and prompt from conversation context ([828b0d2](https://github.com/Mearman/tau/commit/828b0d2df2662f0cbdb5782a3bc9f43e4352d6e5))
* integrate bookmark extension ([2e8ed57](https://github.com/Mearman/tau/commit/2e8ed57df21bc1b4fb443e7915555db8908702b4))
* integrate claude-rules extension ([c6fa22f](https://github.com/Mearman/tau/commit/c6fa22fd2b08d034a318b7c6262ebb5ae963c446))
* integrate custom-footer extension ([5a8dcf3](https://github.com/Mearman/tau/commit/5a8dcf341136efcefa10901a4394f41e4eaf6b51))
* integrate git-checkpoint extension ([64febe2](https://github.com/Mearman/tau/commit/64febe2136cae1f65871def37db5e6f3c16f513b))
* integrate github-issue-autocomplete extension ([ec5c78d](https://github.com/Mearman/tau/commit/ec5c78d84bc0b77f9c2f2d9e2818f9af33d12dc0))
* integrate handoff extension ([e05f1c1](https://github.com/Mearman/tau/commit/e05f1c142379178dfb9d8e763a48dd797f3e4200))
* integrate preset extension ([1406fee](https://github.com/Mearman/tau/commit/1406feee638ba9b4e27039150afe504920b090b7))
* integrate session-name extension ([506e299](https://github.com/Mearman/tau/commit/506e2990ac559dee2ca999645b8cce71df3706ec))
* integrate summarize extension ([f27dd73](https://github.com/Mearman/tau/commit/f27dd73d75d4f6d4a98fd8807c85ca4944f393c3))
* interactive loop manager TUI and Ctrl+L shortcut ([6b4a4fe](https://github.com/Mearman/tau/commit/6b4a4febef452238a87f997c2ac79ce137f94319))
* **loop:** add /loop command with count, duration, cron, and proactive modes ([b12fb55](https://github.com/Mearman/tau/commit/b12fb55d9b282e4494e655274425e60873865e02))
* **loop:** register loop feature in tau entry point ([b572a0f](https://github.com/Mearman/tau/commit/b572a0f666dfbe2273176316cf4d8c2a96c5c1d2))
* **notify:** add Pushover notification provider ([b3deb7c](https://github.com/Mearman/tau/commit/b3deb7c661fa6579ea7a4a41b23a987f54ceebf7))
* **notify:** extract provider architecture for pluggable notification backends ([416bd5f](https://github.com/Mearman/tau/commit/416bd5ffbbbae896ab825dfee28f486f8ade0a63))
* **notify:** scope notification titles to session context ([035a144](https://github.com/Mearman/tau/commit/035a14426674ccbda82d921180e87f6c6066e309))
* register /context command in tau extension entry point ([e7c4f85](https://github.com/Mearman/tau/commit/e7c4f8582dbff492382db3fca54ca91149bdcf22))
* replace todo tool with task tool (nesting, links, status) ([f5876a3](https://github.com/Mearman/tau/commit/f5876a33435bb0050308b6b72494fbb0428430b0))
* scheduled and external callbacks (remind tool + /remind command) ([d72fccb](https://github.com/Mearman/tau/commit/d72fccb0a6065d4954a6fce86c42866f202ca1c8))
* use taller, narrower grid proportions ([61090d6](https://github.com/Mearman/tau/commit/61090d610efceed26d5dd1a43e53ce9a9d1f17fb))

### Bug Fixes

* **bg:** respect explicit bash timeout instead of always using 15s default ([fb64047](https://github.com/Mearman/tau/commit/fb6404720f1adce2974eb6d5b1a9af0358c4ec6d))
* **bg:** suppress duplicate completion notifications after attach ([4356f28](https://github.com/Mearman/tau/commit/4356f28aff8b45e16a289ff32a06c0f68b21e632))
* **ci:** restore config file typechecking via *.config.ts glob ([fdc3b1c](https://github.com/Mearman/tau/commit/fdc3b1c0590ce99a9ab9503b1b8c3174342db70e))
* clear pendingDecisionJobId when job is not found ([608eca0](https://github.com/Mearman/tau/commit/608eca05e33665721ca73a774a60b76424a9fd3a))
* correct grid aspect ratio for square appearance ([90600c7](https://github.com/Mearman/tau/commit/90600c71eb524dfac1757d4d580dc50417acba0c))
* exclude commitlint.config.ts from tsc ([4e44ecb](https://github.com/Mearman/tau/commit/4e44ecbf22f873a505ec47d7b4d49614989e98ce))
* fire-and-forget reload to avoid deadlock with agent loop ([a6ae067](https://github.com/Mearman/tau/commit/a6ae067bd75f16dad202f5e9f632e5825a5541b2))
* **jobs:** suppress duplicate notifications after killing a background job ([2e57dad](https://github.com/Mearman/tau/commit/2e57dada569c2ffda70c3ef700735c2dc6e417a2))
* pass provider/id model to spawned pi -p ([892597a](https://github.com/Mearman/tau/commit/892597ae7ff0bc7cb37d87abbfb4300137d560a1))
* poll ctx.isIdle() before calling reload ([0b9932b](https://github.com/Mearman/tau/commit/0b9932b4bd737618985152ae3bd520c311fe4e8e))
* **release:** correct files field to include src/ directory ([d434132](https://github.com/Mearman/tau/commit/d4341324f9e34a39b98fe36f7544215c6fa0e95c))
* resolve job IDs without job- prefix ([8e25193](https://github.com/Mearman/tau/commit/8e25193e35f066912d3f5c624e3d72c33d7a7bd5))
* three runtime bugs found during live testing ([c9e5c10](https://github.com/Mearman/tau/commit/c9e5c10fbaab9abbb97c6f3dfa3ad3304673e16e))

### Refactoring

* change local .js imports to .ts for test-runner compatibility ([41730d1](https://github.com/Mearman/tau/commit/41730d14ce5daf22ce5e41a9ed315ed48ba8fec3))
* export startStallWatchdog for agent-background consumption ([f600131](https://github.com/Mearman/tau/commit/f6001315768e07119835abc473cba34d2b21f24d))
* extract background commands into src/features/background-commands.ts ([125edcb](https://github.com/Mearman/tau/commit/125edcb557176441d2ee3ffbe494b9971f102101))
* extract background jobs into src/features/background.ts ([e449b92](https://github.com/Mearman/tau/commit/e449b921aa467fe6ffb73059f53bd5f382fe27f4))
* extract notifications into src/features/notifications.ts ([fd2eea5](https://github.com/Mearman/tau/commit/fd2eea50ac596631725bf54df4435afca437e358))
* extract plan mode into src/features/plan-mode.ts ([ecd8c51](https://github.com/Mearman/tau/commit/ecd8c5136021bb9e6309bf3ca769780e04c93496))
* extract shared mutable state into src/state.ts ([18376a8](https://github.com/Mearman/tau/commit/18376a886af740dd124659045e30d0ad103ec57a))
* extract shared type definitions into src/types.ts ([6b06756](https://github.com/Mearman/tau/commit/6b067561ad9eb18710c49ff84b477db15ccdbbb1))
* extract shared utilities into src/utils.ts ([11f31a3](https://github.com/Mearman/tau/commit/11f31a388582b2323720cbeb8d493b35e6a55b8c))
* extract titlebar spinner into src/features/titlebar.ts ([e60eba6](https://github.com/Mearman/tau/commit/e60eba6354d34ec4aba3b2893ab38de5ff26e568))
* extract todo feature into src/features/todo.ts ([3ab5930](https://github.com/Mearman/tau/commit/3ab59300c11290622d901712216029ba41348c24))
* extract tools selector into src/features/tools-selector.ts ([656522f](https://github.com/Mearman/tau/commit/656522f139d0d658017d1d8c582bd66cf2123363))
* rewrite index.ts as slim entry point ([8785998](https://github.com/Mearman/tau/commit/8785998fc00bfe5b9d7a4f57ddc7dee266dd7851))
* **task:** replace parentId field with child-of link model ([5dec2be](https://github.com/Mearman/tau/commit/5dec2bee53881e14ac60fd833401cdcf2a254b9e))

### Documentation

* fix installation section — remove duplicate, add GitHub install ([2eeb8e1](https://github.com/Mearman/tau/commit/2eeb8e1a443c833b66ef88af9aa0ad912dce9a1f))
* **release:** update package description with τ branding ([0d68f03](https://github.com/Mearman/tau/commit/0d68f032595b210701e86521d3cdd63bb09bae93))
* update README for task feature (nesting, links, status) ([0e1f507](https://github.com/Mearman/tau/commit/0e1f5076177fd287d92da509937d4e834c5f5337))
* update README with all new features, commands, and architecture ([9461fd0](https://github.com/Mearman/tau/commit/9461fd0c76916ef14b4909a223348c1e7b91e922))

### Tests

* add 55 tests for task feature (nesting, links, move, remove) ([3cdfae4](https://github.com/Mearman/tau/commit/3cdfae4fd9bb7a79f3e2421badd778716b0c0513))
* add test framework and initial test suite ([4f9894c](https://github.com/Mearman/tau/commit/4f9894c439cdc0c480cbc5ab1f6d5940346e3eea))
* add tests for claude-rules ([809a827](https://github.com/Mearman/tau/commit/809a827e3c36dc631a4944ff1f59900bcb44ae49))
* add tests for github-autocomplete ([e2e5bc4](https://github.com/Mearman/tau/commit/e2e5bc469dbbfc65a1c84bbecb1307c0aff15ceb))
* add tests for handoff ([2f2acd1](https://github.com/Mearman/tau/commit/2f2acd12a96d8324dbaf827bfb6fb502314755ab))
* add tests for notifications ([9eda7dd](https://github.com/Mearman/tau/commit/9eda7dd3b04a9123128524ba8bda0c087ebf49e3))
* add tests for plan-mode ([5ef2f00](https://github.com/Mearman/tau/commit/5ef2f0014e95c3f01f18a184069a2b508fccbeb0))
* add tests for preset ([7a8a454](https://github.com/Mearman/tau/commit/7a8a454980fca523d9c06ce17f74bf1911d279f2))
* add tests for summarize ([e9484a9](https://github.com/Mearman/tau/commit/e9484a91e45ef7c4f78b5f930d41253900573e2d))
* add tests for titlebar ([37bdb00](https://github.com/Mearman/tau/commit/37bdb00915cbc0fb90f167494f62aa136dae8444))
* add tests for tools-selector ([3bee591](https://github.com/Mearman/tau/commit/3bee591e2ec430a135837b530439341d30840f1e))
* add unit tests for /context command ([1af0f70](https://github.com/Mearman/tau/commit/1af0f70243cc644335c98db55023a027b38effa9))
* add unit tests for plan-utils and utils ([7bb4bc1](https://github.com/Mearman/tau/commit/7bb4bc115a488f55449637cde082fddb91e560fe))
* command policy unit tests (phase 3) ([b71890b](https://github.com/Mearman/tau/commit/b71890b6025f23e9b6f7ea140a1ebe8cd6e7e1ab))
* comprehensive unit tests for all new features ([0ca86bb](https://github.com/Mearman/tau/commit/0ca86bbe1dc65bbb2c1e92e72d43a25ee728afdf))
* **task:** add regression test for renderer crash on empty details ([8ce5d5f](https://github.com/Mearman/tau/commit/8ce5d5f505b7749f1f902c2918d43c5dba1dcd32))
* update context tests for context files and skills categories ([ced9b0f](https://github.com/Mearman/tau/commit/ced9b0f4b8b5f250a62992c91f69b1a1a27c7caa))

### Build

* add c8 coverage tool with yargs override for Node 26 ([9a201ac](https://github.com/Mearman/tau/commit/9a201ac950b5a03ada0feb8d66c62be02abc54f0))
* add loop to commitlint scope enum ([4acf56a](https://github.com/Mearman/tau/commit/4acf56af9d156f04c2b1b13f8783d345171611e5))
* add task to commitlint scope enum ([32c836f](https://github.com/Mearman/tau/commit/32c836f997659fe395a7a1c285676c4daf887832))
* configure c8 coverage with .c8rc.json ([e138a8d](https://github.com/Mearman/tau/commit/e138a8dd168198496f9d628208dc0eee9e38ab80))

## [1.4.5](https://github.com/Mearman/tau/compare/v1.4.4...v1.4.5) (2026-05-15)

### Styles

* simplify tsconfig include to src/ directory ([9d5d67f](https://github.com/Mearman/tau/commit/9d5d67fa3646e084d777f0e67bf2487d2b5adee2))

## [1.4.4](https://github.com/Mearman/tau/compare/v1.4.3...v1.4.4) (2026-05-15)

### Refactoring

* move source files into src/ ([506e4cb](https://github.com/Mearman/tau/commit/506e4cb94f8866941d3f57eaec6dd4c6272ee2d4))

## [1.4.3](https://github.com/Mearman/tau/compare/v1.4.2...v1.4.3) (2026-05-15)

### Bug Fixes

* **bg:** hybrid stdio — pipes for bash, file-backed for bash_bg ([dd60f85](https://github.com/Mearman/tau/commit/dd60f85c94808077be9f847436c4ddf32053b858))

## [1.4.2](https://github.com/Mearman/tau/compare/v1.4.1...v1.4.2) (2026-05-15)

### Bug Fixes

* **bg:** embed PID in job ID for cross-instance uniqueness ([c77e29a](https://github.com/Mearman/tau/commit/c77e29a432fa9907e4cb9a9792f876bb345256e1))

## [1.4.1](https://github.com/Mearman/tau/compare/v1.4.0...v1.4.1) (2026-05-15)

### Bug Fixes

* **bg:** namespace log files by pi PID to avoid collisions ([8c6b310](https://github.com/Mearman/tau/commit/8c6b310d3fc486b12f95e9e5110bd6b3ff2340bd))

## [1.4.0](https://github.com/Mearman/tau/compare/v1.3.1...v1.4.0) (2026-05-15)

### Features

* **bg:** file-backed stdio for survivable background tasks ([552375f](https://github.com/Mearman/tau/commit/552375f9f7c37bfe7c6cebf974f671176d723146))

## [1.3.1](https://github.com/Mearman/tau/compare/v1.3.0...v1.3.1) (2026-05-15)

### Bug Fixes

* **bg:** prevent attach from blocking on pending-decision jobs ([a1efd15](https://github.com/Mearman/tau/commit/a1efd15555bc20b8e7cf2fb41d5cb3286d7d1ca7))

## [1.3.0](https://github.com/Mearman/tau/compare/v1.2.1...v1.3.0) (2026-05-15)

### Features

* **notify:** add toggle for respecting system DnD ([5775e6a](https://github.com/Mearman/tau/commit/5775e6a5e358a4c5271fe08267fb8b53bca0ef8f))

## [1.2.1](https://github.com/Mearman/tau/compare/v1.2.0...v1.2.1) (2026-05-15)

### Bug Fixes

* **notify:** decouple persistence and system DnD ([c74d32f](https://github.com/Mearman/tau/commit/c74d32fc34bdd5619790664aed7a19411cd7a55a))

## [1.2.0](https://github.com/Mearman/tau/compare/v1.1.0...v1.2.0) (2026-05-15)

### Features

* **notify:** respect macOS system DnD/Focus mode ([75f160c](https://github.com/Mearman/tau/commit/75f160c194e4f245373d3df9a3b6a58a3bde3a3f))

## [1.1.0](https://github.com/Mearman/tau/compare/v1.0.2...v1.1.0) (2026-05-15)

### Features

* **ui:** add notification config with DnD toggle and persistence ([82d5983](https://github.com/Mearman/tau/commit/82d59830694bea970947974e51214dab94cdba6a))

## [1.0.2](https://github.com/Mearman/tau/compare/v1.0.1...v1.0.2) (2026-05-15)

### Documentation

* align badge style with schema-components ([a483d1a](https://github.com/Mearman/tau/commit/a483d1a094cb853ab0df06a679f2674badc3fe81))

## [1.0.1](https://github.com/Mearman/tau/compare/v1.0.0...v1.0.1) (2026-05-15)

### Bug Fixes

* **ui:** allow bash through pending-decision gate ([a7d3f49](https://github.com/Mearman/tau/commit/a7d3f49753865832f408e6e8b95b5679e35da0fd))

## 1.0.0 (2026-05-15)

### ⚠ BREAKING CHANGES

* rebuild as Tau — disk output, process-group kill, timeout, stall/size watchdog

### Features

* add background tasks extension with Ctrl+Shift+B support ([225060b](https://github.com/Mearman/tau/commit/225060bb5c679367aa7c761e5f3a6d20db288c9c))
* add Ctrl+B as alias for backgrounding ([1f33ef5](https://github.com/Mearman/tau/commit/1f33ef527d07f4332d628348f398d6901da199d6))
* add Ctrl+J shortcut for quick jobs interface access ([fcdbaf8](https://github.com/Mearman/tau/commit/fcdbaf889146e106b3ebf404b05b01c58c13764b))
* agent loop suspension via Ctrl+B /bg /suspend /resume Ctrl+R ([4d3be8a](https://github.com/Mearman/tau/commit/4d3be8a851cc1ac2bda61e72cd22791405598ac2))
* Claude Code-aligned task management UI ([42819f2](https://github.com/Mearman/tau/commit/42819f270d4e55b39fdf2f4838ea49bcd6255b33))
* close remaining UX gaps with Claude Code ([c00a9f4](https://github.com/Mearman/tau/commit/c00a9f4d914a59021a80130571bb95760f4fe080))
* Ctrl+B mirrors Claude Code UX — suspend and resume ([d85fda2](https://github.com/Mearman/tau/commit/d85fda2de5cf134769c97f794270862d49b5bbc5))
* enable agent responses to background job failures ([2894112](https://github.com/Mearman/tau/commit/28941127c89c6ed66c4ed10c7b587f8392ef2fec))
* force a decision after timeout backgrounding ([526bbbe](https://github.com/Mearman/tau/commit/526bbbee856589a1f627acd3f58fe4b352bdf0fe))
* include last agent message in terminal notification ([085f2eb](https://github.com/Mearman/tau/commit/085f2eb79167791641676af7a28382da4b4bc765))
* integrate native terminal notifications from notify.ts ([e8f4d27](https://github.com/Mearman/tau/commit/e8f4d27cac8ee07ed6764e775010834a6c22c301))
* integrate status line from status-line.ts ([d54b910](https://github.com/Mearman/tau/commit/d54b9103045c72397033d50f647da80b7f7d19d8))
* integrate titlebar spinner from titlebar-spinner.ts ([a930eac](https://github.com/Mearman/tau/commit/a930eacbbad1e22d987803586f5faf9090febea6))
* integrate todo, tools, and plan-mode extensions ([9e2dcae](https://github.com/Mearman/tau/commit/9e2dcae15a9350775b8d1291397002f8888d9291))
* notify agent of all terminal states, not just failures ([c6f8bfc](https://github.com/Mearman/tau/commit/c6f8bfcb2e5d9b390b1833963fefd7c3ef68c8ad))
* notify agent via sendMessage on background job completion ([6e0670a](https://github.com/Mearman/tau/commit/6e0670a48158b24efe7a52f7c45167f7058c8739))
* rebuild as Tau — disk output, process-group kill, timeout, stall/size watchdog ([ba205ce](https://github.com/Mearman/tau/commit/ba205ceec5a00456e45e797304a6b05d6e903a96))
* show elapsed time in status line while agent is running ([7cc4b55](https://github.com/Mearman/tau/commit/7cc4b55e7fb044c087b1ddf0aec6df139e9c58e5))

### Bug Fixes

* **ci:** exclude build config files from tsc check ([0413400](https://github.com/Mearman/tau/commit/041340069b0ffdcb5535006f4ddd8bada10aacfd))
* **ci:** remove cache dependency on gitignored lockfile ([af0e152](https://github.com/Mearman/tau/commit/af0e152f434086f0a96ceb6baa391761f5067812))
* **ci:** use no-frozen-lockfile since lockfile is gitignored ([d1d47b2](https://github.com/Mearman/tau/commit/d1d47b29f4b28d166eaa0e8213cc922cefd24cc2))
* mark backgrounded jobs as completed when exit code is null ([c1c25f7](https://github.com/Mearman/tau/commit/c1c25f7e5fdc7d2f62b40803eafb1bec67d1397f))
* remove persistent Ctrl+B background hint notification ([94b6e11](https://github.com/Mearman/tau/commit/94b6e11564d1531071f9067b9d43024ff54e45ce))
* stop elapsed timer between agent turns ([aa9b779](https://github.com/Mearman/tau/commit/aa9b779903b049a96b40e6001ebf368174aa4690))
* truncate log files on creation instead of appending ([a6498d3](https://github.com/Mearman/tau/commit/a6498d38645ffd8b800c5b827b21f373f86e3316))

### Refactoring

* align UX with Claude Code's background tasks ([dc1e810](https://github.com/Mearman/tau/commit/dc1e81089978b68537c8dbe01fbe0e8d045dc16b))
* detach spawned processes and inherit environment ([986f804](https://github.com/Mearman/tau/commit/986f804e4dec48d3c9dc2e38661d24023a1270f3))
* extract showJobsInterface as shared function ([15ef41c](https://github.com/Mearman/tau/commit/15ef41c7ac0315e16d484769726b8dc7dd8677d9))
* limit agent messages to failures and use followUp delivery ([f4fe6e4](https://github.com/Mearman/tau/commit/f4fe6e4aa1fbbec186d3bc833aff2fe0a90afc3c))
* remove redundant session lifecycle handlers ([ac8a494](https://github.com/Mearman/tau/commit/ac8a4948f66580b05ab567e16b57d153d2a652e5))

### Documentation

* add npm badges, installation section, and MIT licence ([0686ad6](https://github.com/Mearman/tau/commit/0686ad66e15ec1fedcaf2f9d63c6856b0df321e4))
* add README with usage and API documentation ([234e55e](https://github.com/Mearman/tau/commit/234e55e008d6d56c66756a387f03bbb8f47776dc))
* document Ctrl+J shortcut in keyboard shortcuts table ([e5d9ffa](https://github.com/Mearman/tau/commit/e5d9ffac484cb2f2a1b35d6da0a005197ced85a1))
* reposition Tau as QoL extension, not just background tasks ([240556b](https://github.com/Mearman/tau/commit/240556b0a59b0b8a912645f59e1a64270e82c83a))
* rewrite README for Tau extension ([53f66db](https://github.com/Mearman/tau/commit/53f66dba7b70ab67fc77c905d57f398b8b2b8b54))

### Styles

* normalise indentation in config and plan utils ([26cabaf](https://github.com/Mearman/tau/commit/26cabaf4d9ce651f2eb0e95784b1f3cdd6ee35a2))

### Build

* add package.json — tau extension with zero runtime dependencies ([1c24066](https://github.com/Mearman/tau/commit/1c24066fe3c38d1a5484cff67cd6adbfd9eccd2b))
* add TypeScript configs with [@earendil-works](https://github.com/earendil-works) path aliases ([e5ae77b](https://github.com/Mearman/tau/commit/e5ae77b0a24b736db81a7c62594d4984904592b2))
* **check:** resolve types from node_modules instead of hardcoded paths ([f3e976b](https://github.com/Mearman/tau/commit/f3e976b6581eaf44c43f9bf9edc35662586d57e6))
* **deps:** add editorconfig, prettierrc, and npmrc ([80e469b](https://github.com/Mearman/tau/commit/80e469b64fe4eec06778dfe977aa50c104114bd6))
* **deps:** ignore pnpm-lock.yaml ([0e7bb3c](https://github.com/Mearman/tau/commit/0e7bb3cb9caf2e07fcda143d7058657e0279acb0))
* **release:** configure pi-tau as publishable pi package ([7010101](https://github.com/Mearman/tau/commit/701010114ab4cd25b9904f7680b454739d18c766))
* **release:** merge tsconfig and type-check release tooling ([2201b5d](https://github.com/Mearman/tau/commit/2201b5d9e613c27660881fcf9a01278dbd76d76f))

### CI

* add CI and Dependabot workflows ([f492955](https://github.com/Mearman/tau/commit/f492955c7b529a8c41607ce28ede18876a28ebb0))
* pin Node.js 26.1.0 via .tool-versions ([6877bcb](https://github.com/Mearman/tau/commit/6877bcb1e0384a0f85f338380b2d43fb2720ffa0))
* **release:** add commitlint and semantic-release configuration ([162cef6](https://github.com/Mearman/tau/commit/162cef6f0febcdbdde94129ba51291c82b0beb37))

### Chores

* add .gitignore for node_modules and lockfile ([c492d9b](https://github.com/Mearman/tau/commit/c492d9b6f7eca0283f8c4e12c0c44d64b0f2bb64))
