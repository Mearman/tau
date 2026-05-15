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
