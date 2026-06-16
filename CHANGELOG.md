## [2.0.4](https://github.com/Mearman/tau/compare/v2.0.3...v2.0.4) (2026-06-16)

### Bug Fixes

* **agent-sdk:** flatten history into one user message ([5b208af](https://github.com/Mearman/tau/commit/5b208afa3083b5aca9ee01dbfe43182778736bf3))

### Refactoring

* **agent-sdk:** type-guard settings parsing and test merge precedence ([0a5415a](https://github.com/Mearman/tau/commit/0a5415ac8ef31ad3376a6b62e5963540c500ce3d))

## [2.0.3](https://github.com/Mearman/tau/compare/v2.0.2...v2.0.3) (2026-06-16)

### Tests

* reframe waitForChildProcess regression around the drain invariant ([1ca4b8c](https://github.com/Mearman/tau/commit/1ca4b8cf7d24961567aca233c96f4bd82e63e45f))

## [2.0.2](https://github.com/Mearman/tau/compare/v2.0.1...v2.0.2) (2026-06-16)

### Refactoring

* remove unused git-checkpoint module ([14cf11a](https://github.com/Mearman/tau/commit/14cf11aed26b9cd8c9c9d618bd417cec6116f083))
* **web-search:** apply formatting and resolve lint warnings ([80ba401](https://github.com/Mearman/tau/commit/80ba4019b0e1379cc68595a2ffd97d30d458fb0f))

### Styles

* **context-files:** apply prettier formatting ([113ab50](https://github.com/Mearman/tau/commit/113ab502cdd549b0064e30edaa5b6d5a3c6efcd9))

## [2.0.1](https://github.com/Mearman/tau/compare/v2.0.0...v2.0.1) (2026-06-16)

### Bug Fixes

* **agent-sdk:** accept apiKeySource 'none' as subscription auth ([79e7c9b](https://github.com/Mearman/tau/commit/79e7c9b398d4b767a602482cc9bd077b4e092583))

## [2.0.0](https://github.com/Mearman/tau/compare/v1.8.0...v2.0.0) (2026-06-16)

### ⚠ BREAKING CHANGES

* **context-files:** User-saved overrides keyed on 'claude-rules' are
silently dropped on upgrade. Re-save with the new id:
/tau set instructions off

### Features

* **agent-sdk:** add Claude Agent SDK provider ([eb98857](https://github.com/Mearman/tau/commit/eb988570eb6fb8eca8fcfd0d605ecf91489835ff))
* **context-files:** add dedupeByCanonicalName helper for rules merge ([d1b60c8](https://github.com/Mearman/tau/commit/d1b60c856b2c17df4da66b566d56a0022c22ddda))
* **context-files:** add global rules scan and applies-to frontmatter ([23610b0](https://github.com/Mearman/tau/commit/23610b0814c7054d74e5e1b8595cc9414baef455))
* **context-files:** add memory feature for MEMORY.md auto-load ([7308b68](https://github.com/Mearman/tau/commit/7308b688ecb246cabafdef7e5cca1314f6d3780f))
* **context-files:** rename claude-rules feature to instructions ([18838b4](https://github.com/Mearman/tau/commit/18838b44cf71cd7c5210a8bac9ef2fe46fcb623e))
* **permissions:** add dontAsk mode, fix defaultMode mapping ([b27b03b](https://github.com/Mearman/tau/commit/b27b03be8ecf669ac06409c2b5a14042ffca3ca7))
* remove GitHub autocomplete feature ([9b6250e](https://github.com/Mearman/tau/commit/9b6250e9c125bbc6fc588caf632b6ac10ba656a9))

### Bug Fixes

* **bash-tmux:** reuse tmux session across foreground commands ([0435da2](https://github.com/Mearman/tau/commit/0435da20cec9c96068aace8f6b672d434bc823b3))
* **context-files:** resolve symlinks to deduplicate via realpath ([b48dd25](https://github.com/Mearman/tau/commit/b48dd255ffb0517280add0663cd922a6cd5a5063))
* **deps:** declare marked and @anthropic-ai/sdk as direct dependencies ([93fb11f](https://github.com/Mearman/tau/commit/93fb11f2bfa327b8d3812e66288e4fd33a3e7922))
* **deps:** override ws and protobufjs to clear high-severity advisories ([b5d5561](https://github.com/Mearman/tau/commit/b5d55616ecc8b11789f18948c1b02991324ac2c9))
* **permissions:** revert defaultMode fallback to allow ([8aee6b2](https://github.com/Mearman/tau/commit/8aee6b2714a117f74858301cf2eeb0ce0830251b))

### Refactoring

* **context-files:** rewrite [@include](https://github.com/include) extractor to use marked lexer token walk ([0b3d253](https://github.com/Mearman/tau/commit/0b3d25302ef081439f398e42a6ded94d2ff1353a))
* rename claude-rules to context-files ([c3e2ef7](https://github.com/Mearman/tau/commit/c3e2ef7fc2c226990204f2136bd4173b1db35500))
* wire context-files feature into extension entry point ([e69c7ca](https://github.com/Mearman/tau/commit/e69c7ca1e66f212d4d4dd923e1925accee876f89))

### Tests

* **context-files:** add link-based include syntax and symlink dedup tests ([eae2cc8](https://github.com/Mearman/tau/commit/eae2cc8c1252a26e0fb2658544f8429918eee211))
* **context-files:** cover local files, first-match-wins, independent loading, recursive rules ([93ed541](https://github.com/Mearman/tau/commit/93ed541616feaff06aa4d90b717a527011341c36))
* replace claude-rules tests with context-files tests ([dc4f41c](https://github.com/Mearman/tau/commit/dc4f41ceb3c6ab90f2b47cdcf76a8b356821e64e))

### Chores

* **deps:** add context-files to commitlint scope enum ([86fe322](https://github.com/Mearman/tau/commit/86fe32231853fcd78f1040e105019285308f4ca9))

## [1.8.0](https://github.com/Mearman/tau/compare/v1.7.0...v1.8.0) (2026-06-06)

### Features

* **web-browse:** add network request/response collector ([0246c0a](https://github.com/Mearman/tau/commit/0246c0ab4abe898e2c9369d779cff9aa5c357e87))
* **web-browse:** persist isolated browser across tool calls ([dcf255a](https://github.com/Mearman/tau/commit/dcf255ae234d672fe24aeae281166626ef18c241))
* **web-browse:** smart mode fallback, persistent browser, and enhanced page handling ([67864a7](https://github.com/Mearman/tau/commit/67864a71448dcf949ed66d3bba97f9f64e85bd89))

### Bug Fixes

* **web-browse:** retry stale bridge socket connections ([001fe29](https://github.com/Mearman/tau/commit/001fe299e988422db55f8c3ad81184f532a66f60))

### Styles

* **web-browse:** apply consistent formatting to new code ([0bf5a91](https://github.com/Mearman/tau/commit/0bf5a9195d3117a748fc2ca7dd400f30aa028d53))

## [1.7.0](https://github.com/Mearman/tau/compare/v1.6.0...v1.7.0) (2026-06-05)

### Features

* add /goal command and event hooks ([afb1521](https://github.com/Mearman/tau/commit/afb1521f6fd78aaa79b3e0f8006773a5198876eb))
* add /tau CLI arg parser and inline autocomplete ([4d27fd9](https://github.com/Mearman/tau/commit/4d27fd9986bcae196e35b13680f530dd162dd1ac))
* add /tau command handler ([68b8715](https://github.com/Mearman/tau/commit/68b87158e3df608d8928be68cb4ea0e7af9da585))
* add activeGoal field to TauState ([536d007](https://github.com/Mearman/tau/commit/536d0077a7621bdbb80d0fe9141b329a9c62a60f))
* add feature state restoration from session entries and files ([0d42882](https://github.com/Mearman/tau/commit/0d42882693d1797bf258685ee0110c051419d040))
* add file I/O layer for tau feature toggles ([ef4b35e](https://github.com/Mearman/tau/commit/ef4b35eeb58ea3fc68b39597837e9391620d6ea6))
* add GoalState type for /goal feature ([770958d](https://github.com/Mearman/tau/commit/770958d14a84807433b8d691cea0bff0b11b8e05))
* add hard continuation to /goal via agent_end ([b4126e5](https://github.com/Mearman/tau/commit/b4126e5ef97a917bbb31702e0f8bdd9f7576ce81))
* add scope resolver, feature registry, and toggle helpers ([1587687](https://github.com/Mearman/tau/commit/1587687fc2bde2126a5c221577e6297bbaa4b667))
* add tmux-backed bash backend with automatic fallback ([64be73d](https://github.com/Mearman/tau/commit/64be73d064f7f61f93f8f3202e8a16ce476ba78b))
* expose profile targeting in web tools ([314a09a](https://github.com/Mearman/tau/commit/314a09a33a7fe143e94dbc10d878204402c692c6))
* gate every feature behind the toggle system ([457ede4](https://github.com/Mearman/tau/commit/457ede426375f306ad9bf29c7f2280560e193561))
* **loop:** treat bare number as count mode ([de3fdee](https://github.com/Mearman/tau/commit/de3fdee12e96b5bcc9a1ae29f2b58b7f1d6209ef))
* make bridge client profile-aware ([564beab](https://github.com/Mearman/tau/commit/564beab06b06d7b1c986330922ec21fed8d44b78))
* **permissions:** add /perm add command for manual rule creation ([82f83e7](https://github.com/Mearman/tau/commit/82f83e7c681b71e7286b8c2b9b2173a97822f55a))
* **permissions:** add /perm command and Ctrl+Shift+P shortcut ([2a0dc45](https://github.com/Mearman/tau/commit/2a0dc4504f4fb1071e9396babb0bf5d5e9fb3625))
* **permissions:** add ask-rule prompt timeout with retry escape hatch ([d4715f8](https://github.com/Mearman/tau/commit/d4715f889b8a37a9b9dbf82ca35ce23ca8013aa5))
* **permissions:** add bash subcommand splitting and wrapper stripping ([8a8a0c9](https://github.com/Mearman/tau/commit/8a8a0c95f4922af6f5519978456beb2d64a8c645))
* **permissions:** add enter_plan_mode and exit_plan_mode tools ([30a58c5](https://github.com/Mearman/tau/commit/30a58c58d64fc801c4a57f1ac197a6ec2532eb02))
* **permissions:** add filesystem permission checks ([06805c7](https://github.com/Mearman/tau/commit/06805c70e84e5152c1bfe0dd3cd6dfa6e4ed61b0))
* **permissions:** add filesystem permission checks ([14e4129](https://github.com/Mearman/tau/commit/14e41299f3eec0ee33230bb2055e331fd7f84608))
* **permissions:** add permission decision pipeline ([1a9d697](https://github.com/Mearman/tau/commit/1a9d697cf72968c42e1abae8c5431a6f067cc6b8))
* **permissions:** add permission mode and rule types ([0da5d14](https://github.com/Mearman/tau/commit/0da5d149d0ad2714a8838715deae34165a938e33))
* **permissions:** add permission mode definitions and cycling ([00a1894](https://github.com/Mearman/tau/commit/00a18949a46ebaaabf62f18af8cfdf17f8cc0657))
* **permissions:** add permission state fields to TauState ([156d410](https://github.com/Mearman/tau/commit/156d41085d90ec32a5fb8fa6bdd233731e838b6f))
* **permissions:** add permission update destination types ([a2ddd92](https://github.com/Mearman/tau/commit/a2ddd9269960b714c797caa9ae872fbcaae964df))
* **permissions:** add PermissionPrompt TUI component ([7c22d7f](https://github.com/Mearman/tau/commit/7c22d7fb1c083069882101376b26e07c2f915f51))
* **permissions:** add plan file management module and plan state ([afa5798](https://github.com/Mearman/tau/commit/afa57983186648b5b52165302ba11326eb942dc8))
* **permissions:** add rule parsing and pattern matching ([dda49cd](https://github.com/Mearman/tau/commit/dda49cd96c96d8fbec5f8aad2854e63af3246c4d))
* **permissions:** add sessionRules to extension state ([ee2cdda](https://github.com/Mearman/tau/commit/ee2cdda120a37cac96ffa750fd1b2b10514ea4c9))
* **permissions:** add settings file writing for allow rule persistence ([13f43ac](https://github.com/Mearman/tau/commit/13f43ac99e844bc95669bf5f1db8aaa1575f688e))
* **permissions:** add settings loader for .claude/settings.json ([453be1c](https://github.com/Mearman/tau/commit/453be1ca48ab21014cb19c08eb759da3b0412561))
* **permissions:** add task tree parallelism analysis ([2b292f5](https://github.com/Mearman/tau/commit/2b292f50b0bc4551485a4259f7acc8e93275f59e))
* **permissions:** change default mode from ask to allow ([a4df68e](https://github.com/Mearman/tau/commit/a4df68e647a9d8d465a8c03429a399e4db3dcbb1))
* **permissions:** ctrl+shift+m shortcut with timed hint in status bar ([fa9b902](https://github.com/Mearman/tau/commit/fa9b902904ce10829d9fb9b913b1c17b1ab9a53b))
* **permissions:** ctrl+tab for mode cycling ([f90bfe9](https://github.com/Mearman/tau/commit/f90bfe99fd85e0d1492cd17cde81603b2810b8e5))
* **permissions:** destination-aware permission prompt ([e87b1e4](https://github.com/Mearman/tau/commit/e87b1e4f2f6fa6d21e6e78699954add2380f8d05))
* **permissions:** pass sessionRules through permission state ([129d525](https://github.com/Mearman/tau/commit/129d5251f49cc65833ed655de7b33513cb1ff107))
* **permissions:** shift+tab for mode cycling, ctrl+shift+t for thinking ([4ab13ef](https://github.com/Mearman/tau/commit/4ab13efd854c2a21d45c6a622f387a1bc36a559a))
* **permissions:** use Tab to cycle permission modes ([02651ad](https://github.com/Mearman/tau/commit/02651ad991c514f447d60df993c9ee374f983fd4))
* **permissions:** wire permission pipeline into tool_call handler ([35593b7](https://github.com/Mearman/tau/commit/35593b7222738f3d978c5ca5e1f9eb14ef67499a))
* **permissions:** wire prompt decisions to rule persistence ([01c99b6](https://github.com/Mearman/tau/commit/01c99b6fa208b414427d7561d44fad8c3e43db77))
* register goal feature in tau entrypoint ([acf7ce0](https://github.com/Mearman/tau/commit/acf7ce038a4d7b27b6e8e36c84e46a12e04b07a8))
* resolve chrome profiles with markers ([740f85f](https://github.com/Mearman/tau/commit/740f85ffcf2a74f5d51f10a620c92668ebdbc1da))
* support unsetting tau feature overrides ([181b7e8](https://github.com/Mearman/tau/commit/181b7e8c093b567d8e2183fd72fb84a29084594c))
* TUI and setFeatureOverride ([b905be3](https://github.com/Mearman/tau/commit/b905be3568f4b9f74d97c9741f74cb6fe703f111))
* **web-browse:** add converter scripts to chrome extension bundle ([4285ab5](https://github.com/Mearman/tau/commit/4285ab59aab4420151e7ede3d6c433b77ea77e2f))
* **web-browse:** add session isolation via incognito windows ([80b9503](https://github.com/Mearman/tau/commit/80b95036b1c911518cee97c8631180a606e79001))
* **web-browse:** auto-install CloakBrowser on first isolated mode use ([5610a1f](https://github.com/Mearman/tau/commit/5610a1fed4d452aeb578647773b016aabdbd03cd))
* **web-browse:** cache chrome_list results with 30-second TTL ([1c07dc7](https://github.com/Mearman/tau/commit/1c07dc7d0bff3eff4a3400e3be9d98a4a881e48a))
* **web-browse:** github-aware structure extraction ([61457d5](https://github.com/Mearman/tau/commit/61457d5ffe29829492a84efba5c52f5769f16988))
* **web-browse:** inject converters on demand in bridge mode ([6bdbecc](https://github.com/Mearman/tau/commit/6bdbecc9585c49c140eb28acc0291e41239d5ed1))
* **web-browse:** integrate patchright and cloakbrowser for stealth browsing ([5498835](https://github.com/Mearman/tau/commit/5498835136b67860a10f00b0560579382be31e39))
* **web-browse:** redact sensitive values from bridge output ([ab14525](https://github.com/Mearman/tau/commit/ab14525274dc8dce2d9a0299f26454ad25c44186))
* **web-browse:** show URL/query in status bar during web tool calls ([0ab55dd](https://github.com/Mearman/tau/commit/0ab55dd847dac39f96ec51f9860d51c6efcfbfe5))
* **web-search:** add web search via Claude, Brave, and DuckDuckGo ([53065cf](https://github.com/Mearman/tau/commit/53065cf9eed1242497aedab994408864d212d585))
* **workflow:** add activeWorkflow field to TauState ([be65710](https://github.com/Mearman/tau/commit/be6571039c421b0181a857a766bd1374e859cfdb))
* **workflow:** add workflow feature module ([32adc0a](https://github.com/Mearman/tau/commit/32adc0ab0a19fcd8c35abada11e759887743808b))
* **workflow:** register workflow feature in tau entrypoint ([fb97805](https://github.com/Mearman/tau/commit/fb97805905f9a1a93d767ba49fb71a63e93513de))

### Bug Fixes

* allow Esc to cancel jobs attach while waiting for completion ([07379f0](https://github.com/Mearman/tau/commit/07379f00a703783a7e12a6a0a1b6453e351de5c1))
* anchor wildcard patterns and escape dots in permission rule matching ([19e7bfe](https://github.com/Mearman/tau/commit/19e7bfe1edcd153274004ce1297a796609de8a92))
* **bash:** pre-compute output paths to eliminate window-ID mismatch ([039b978](https://github.com/Mearman/tau/commit/039b9788e388359cdaf0d7167ea03731a89df2b9))
* **bash:** run commands to completion in non-interactive mode ([6332a4f](https://github.com/Mearman/tau/commit/6332a4fd7bc6bac927e03c6eaf1cb22b130d9e06))
* **bash:** use captureOutput in tmux foreground completion path ([3e8b0cf](https://github.com/Mearman/tau/commit/3e8b0cfab3c6e20b76dbeca8755744d69d508a74))
* bypass pnpm deadlock in git hooks by invoking tools via node ([8cf22ca](https://github.com/Mearman/tau/commit/8cf22ca9aaf4316f18c41023f0baff541a1e340f))
* bypass pnpm deadlock in lint-staged by calling eslint via node ([3396cf4](https://github.com/Mearman/tau/commit/3396cf49ebff33b9b12ee40352c9efd62b0f4fc1))
* capture tmux output directly ([acded8a](https://github.com/Mearman/tau/commit/acded8ac8474dabe2b6ac85c3fdcf8215b515dbf))
* clean up backgrounded foreground jobs on process exit ([7021baa](https://github.com/Mearman/tau/commit/7021baacce0b24f9720350600b208b1bead1567a))
* clean up foreground job entries on quick completion and concurrent timeouts ([2c2b2cd](https://github.com/Mearman/tau/commit/2c2b2cd695427effc6fba27b173c6a7ef43bb34a))
* clean up stale tmux run dirs and fix pre-existing lint errors ([c2dc456](https://github.com/Mearman/tau/commit/c2dc456dbb87be85b4c82127099de4f63c8bb2ac))
* detect dead process in jobs attach to prevent indefinite hang ([200a57e](https://github.com/Mearman/tau/commit/200a57ec77c7f959ff58549e9eea6ce962ef2e6a))
* **goal:** scope goal restoration to the active branch ([44aba53](https://github.com/Mearman/tau/commit/44aba532b36dd10dc4d02c9d1d231056f739129d))
* graceful tmux fallback, window cleanup, and unused import removal ([d355577](https://github.com/Mearman/tau/commit/d355577f3fe2d5d70b5267da0ba834b5ed3da0a8))
* kill orphaned tmux sessions and add lifecycle integration tests ([8cae501](https://github.com/Mearman/tau/commit/8cae501fd289f7c261a623bcdde3d60acafccaae))
* **permissions:** always show permission mode in status bar ([f265544](https://github.com/Mearman/tau/commit/f2655446bc368465a70a85524f053ab483487ad0))
* **permissions:** hide status bar indicator in allow mode, not ask ([1244bb0](https://github.com/Mearman/tau/commit/1244bb0aaeaf4877acba5a78a6d875fbadded973))
* **permissions:** match wildcard patterns as unanchored regex ([4ebb480](https://github.com/Mearman/tau/commit/4ebb480e1273dfc76bd81ff0de68fc7d4c477857))
* **permissions:** prompt for ask rules in allow mode ([81d4a40](https://github.com/Mearman/tau/commit/81d4a401f30e2a30422e9bda226db8c0c6255994))
* reattach tmux background jobs on session restart ([d5dd02b](https://github.com/Mearman/tau/commit/d5dd02b15ea1cf044930d755d8ce8d7089eda68c))
* track agent idle state in loop ticks and force-exit test runner ([2072a93](https://github.com/Mearman/tau/commit/2072a93c9a8336b7d5ea8f4e12c5704cd7f9c4b8))
* **web-browse:** bundle converter scripts inline instead of external path ([90c228b](https://github.com/Mearman/tau/commit/90c228be15a2b3a1466a68027988a09613f035f5))
* **web-browse:** re-apply inline converter scripts after merge ([2cb87a3](https://github.com/Mearman/tau/commit/2cb87a35e149b78c70358bb6183165d823139a80))
* **web-browse:** use 'dim' instead of 'cyan' for web tool status colour ([9be4c70](https://github.com/Mearman/tau/commit/9be4c70909ae852d6766bb20a74e245fd9237fa8))
* **workflow:** enforce determinism at VM sandbox level ([7c131fb](https://github.com/Mearman/tau/commit/7c131fb77f8fcf917355ab17ab69d5df8bb3a010))
* **workflow:** match agent_bg spawn flags for nested pi compatibility ([300396b](https://github.com/Mearman/tau/commit/300396bea2ee2065201c50d9007ad08fa45348e1))
* **workflow:** remove TDZ violation in onProgress callback ([bc6bcb6](https://github.com/Mearman/tau/commit/bc6bcb67f32500359f1346b02206c1cba1ef1664))
* **workflow:** use --no-session for ephemeral agents, strip escape sequences ([d013d5d](https://github.com/Mearman/tau/commit/d013d5d4ec5f5aa79b0beef8ddc558d3a68ef97b))
* **workflow:** use ExtensionContext for type compatibility ([abba362](https://github.com/Mearman/tau/commit/abba36280adef95c7b2dbcd6ba9e3364f5d08386))

### Refactoring

* **permissions:** remove deprecated plan mode legacy code ([623804c](https://github.com/Mearman/tau/commit/623804cd8f606417493d230e777d925984a8244e))
* **permissions:** unify legacy plan toggle with new plan system ([b4379a8](https://github.com/Mearman/tau/commit/b4379a80d59ba1ca39a03632d5324be5cb2465d3))
* **permissions:** use .ts import extensions ([30877fb](https://github.com/Mearman/tau/commit/30877fb5e4e7d825a472681e4a9627062aecebb2))
* **plan:** relocate plan files from cwd-relative to session directory ([db42a54](https://github.com/Mearman/tau/commit/db42a5480549cd0b417d0cc2347fac2376c9696b))
* **plan:** use session directory for plan-mode toggle and tools ([06b162f](https://github.com/Mearman/tau/commit/06b162f60c3ffa0197ae6ff51821d39ba4da4b5d))
* remove redundant type assertion on jobData in tmux reattach ([7c91c59](https://github.com/Mearman/tau/commit/7c91c59400a0e089b32a7f890425e17ede0183b6))
* **web-browse,goal:** replace type assertions with type guards ([079b59b](https://github.com/Mearman/tau/commit/079b59b423cb7272baed2d12f1d203552f50a152))

### Documentation

* document feature toggles in README ([5d8bc87](https://github.com/Mearman/tau/commit/5d8bc873b50081b941d35f665b695892663ef456))

### Styles

* fix long-line formatting in permissions status bar code ([36df29e](https://github.com/Mearman/tau/commit/36df29e35dfde2344aeebe56baa804de2d63b380))
* **permissions:** fix linting in permission pipeline ([4d8d63e](https://github.com/Mearman/tau/commit/4d8d63ed432953713b52231bfc33736a2ffc0391))
* **plan:** apply ESLint/Prettier formatting to plan file refactor ([a05a1b1](https://github.com/Mearman/tau/commit/a05a1b157de986b834f7eaed108c22a11868fcb1))
* reformat spawn args in workflow ([af8e7cf](https://github.com/Mearman/tau/commit/af8e7cf4ca6cf98b90574c855ebc52156b3d59b0))
* remove trailing comma after eslint --fix ([b8e4a94](https://github.com/Mearman/tau/commit/b8e4a945c97e63b9280ef6eda260874119c22dc2))
* tidy web browse profile text ([6664c77](https://github.com/Mearman/tau/commit/6664c770ebdc09b551f82ce2f39836c78aa608af))
* **web-browse:** fix indentation after merge ([aea56cf](https://github.com/Mearman/tau/commit/aea56cf326d4c753ac0ae79ab2514440f08ccf42))
* **workflow:** fix formatting from eslint --fix ([e9ad370](https://github.com/Mearman/tau/commit/e9ad3702fe5ab9b3eeea8dc7ba0984e5145ee7b9))
* **workflow:** normalise whitespace in executeRun helper ([59bbd5c](https://github.com/Mearman/tau/commit/59bbd5cf3a1c9fcd24a4bcd305b6be9908987090))

### Tests

* add unit tests for goal feature ([0d7cc6b](https://github.com/Mearman/tau/commit/0d7cc6b6b04dd0c1281b3150a37d664eb1818700))
* **bash:** add integration tests for path-mismatch fix and captureOutput ([90404ed](https://github.com/Mearman/tau/commit/90404ed17e2116d15577e34477d67d3bbb563863))
* comprehensive permission pattern matching coverage ([02008fd](https://github.com/Mearman/tau/commit/02008fd9afee426e9e1a70f88721c8c038be8464))
* cover wildcard false positives and dot-literal semantics ([f57472f](https://github.com/Mearman/tau/commit/f57472f741adb1e0f73236ff8b62cf5fb4b36193))
* expand permission pattern matching coverage ([6d63529](https://github.com/Mearman/tau/commit/6d63529c911db4b11e6cd76280302a3b4d0f6ef7))
* fix lint errors in goal unit tests ([2cb6da3](https://github.com/Mearman/tau/commit/2cb6da35cd3e9691f41a4aa3eaf024fed7bfe43b))
* **permissions:** cover ask rules in allow mode and wildcard matching ([1ff40fc](https://github.com/Mearman/tau/commit/1ff40fc1a84d4b62e9821fed38decad5a9ced6f0))
* **permissions:** cover ask-rule timeout behaviour ([e55c21c](https://github.com/Mearman/tau/commit/e55c21c5dd812bfe049c7e30b9d347f20bf66195))
* verify backgrounded foreground jobs clean up on process exit ([3baf871](https://github.com/Mearman/tau/commit/3baf871026226881c7965bde7b20e1fecdcbe600))
* verify foreground cleanup and concurrent timeout guard ([213f618](https://github.com/Mearman/tau/commit/213f6189b695d7765de32995b45ea91f83f52455))
* verify jobs attach returns promptly for dead-process zombie jobs ([154ffeb](https://github.com/Mearman/tau/commit/154ffebb77ea725e03641e10520ddb40db294611))
* verify jobs attach returns promptly on abort signal ([1e5bcec](https://github.com/Mearman/tau/commit/1e5bcecfbf0799d7fc1a5cf380ba92b1253bbbe4))
* verify loop ticks send without deliverAs when agent is idle ([c47f93d](https://github.com/Mearman/tau/commit/c47f93d75d19c2c25274a93c6207d13f711a7ed6))
* **web-search:** add unit tests for search providers and tool ([7f1d3c9](https://github.com/Mearman/tau/commit/7f1d3c9b14698ae876b69c5d8981bfa3762a9a51))
* **workflow:** add unit tests for workflow feature ([cc7957c](https://github.com/Mearman/tau/commit/cc7957c70f4c3523f33934d33b29cbc409bbbbd8))

### Chores

* add commitlint.config.ts to eslint allowDefaultProject ([ef317ea](https://github.com/Mearman/tau/commit/ef317ea6938dd38dc1e188d0fff514d8126b0896))
* add permissions to commitlint scope enum ([d3a664e](https://github.com/Mearman/tau/commit/d3a664eeac120ac197bc5cd4830f35ca888c8b64))
* **build:** add workflow to commitlint scope enum ([be00080](https://github.com/Mearman/tau/commit/be00080e0420dd048d1cd7fc11665f5cd79b10c4))
* disable handoff feature ([33b084d](https://github.com/Mearman/tau/commit/33b084d0eefe2d0c4d1bbfcb9890e50af8bc2e40))

## [1.6.0](https://github.com/Mearman/tau/compare/v1.5.2...v1.6.0) (2026-05-25)

### Features

* add /handover command with cross-directory launch modes ([90c1c37](https://github.com/Mearman/tau/commit/90c1c37f175da90068b4243c20d09cfab5df6196))

## [1.5.2](https://github.com/Mearman/tau/compare/v1.5.1...v1.5.2) (2026-05-25)

### Bug Fixes

* use root index.ts entry point for correct extension display name ([e5c5968](https://github.com/Mearman/tau/commit/e5c5968c64c06a39921ca86bedf1f603006a8ab8))

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
