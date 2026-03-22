# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.2.1](https://github.com/neel/ace-interview-prep/compare/v0.2.0...v0.2.1) (2026-03-22)

## [0.2.0](https://github.com/neel/ace-interview-prep/compare/v0.1.4...v0.2.0) (2026-02-20)


### ⚠ BREAKING CHANGES

* The
Workspace not initialized. Running init...

### Features

* add cli e2e test harness ([4fb72b5](https://github.com/neel/ace-interview-prep/commit/4fb72b5ff13b1b7b30c91f5f7ebd68d75e4c6727))
* **categories:** add CategoryGroup type and per-category group mapping ([ea60a91](https://github.com/neel/ace-interview-prep/commit/ea60a911995e3824a5abb30de96f8971d6e171f0))
* **generate,feedback:** wire commands to group-specific prompts ([7141ecc](https://github.com/neel/ace-interview-prep/commit/7141eccd77a8afdfacb5ee72af69a53f94b4a1bc))
* **prompts:** split monolithic prompts into per-category-group variants ([d39e10e](https://github.com/neel/ace-interview-prep/commit/d39e10e3e20c7402fb499ede3e40dc8f6991e654))
* remove ace add command ([6c990c4](https://github.com/neel/ace-interview-prep/commit/6c990c4f0cb42064ec687cf99faf59c77c35536f))


### Bug Fixes

* prevent path resolution crash in commands ([309cdcd](https://github.com/neel/ace-interview-prep/commit/309cdcdb3ec206435d86396553a0792f4f7f4107))

## [0.1.4](https://github.com/neel/ace-interview-prep/compare/v0.1.3...v0.1.4) (2026-02-17)


### Features

* **cli:** add `ace dispute` command and harden test generation prompt ([58673be](https://github.com/neel/ace-interview-prep/commit/58673becb6ee7bd3484e85774f9a3fc01b96922d))
* **llm:** add configurable default model provider ([20a2895](https://github.com/neel/ace-interview-prep/commit/20a289575f9677642fc3f1c2073b100456bf6c49))


### Bug Fixes

* **dispute:** use spawnSync, exit codes, and defer provider requirement ([94f2df1](https://github.com/neel/ace-interview-prep/commit/94f2df1e27296875a6c8e721abfadf12a2231c3f))

## [0.1.3](https://github.com/neel/ace-interview-prep/compare/v0.1.2...v0.1.3) (2026-02-16)


### Features

* **cli:** make commands interactive with selectable lists and --all flag ([5e9c824](https://github.com/neel/ace-interview-prep/commit/5e9c8243e419abda0f8ebaf0ed0258a2ab5c96ba))
* **lib:** add category hints and interactive question picker ([aee64cb](https://github.com/neel/ace-interview-prep/commit/aee64cb84511da363d63c978379eedbed45baf33))


### Bug Fixes

* prevent LLM from generating fully implemented solutions ([f0ce433](https://github.com/neel/ace-interview-prep/commit/f0ce433231b675ec8052db01e541b95ec733d2e5))

## [0.1.2](https://github.com/neel/ace-interview-prep/compare/v0.1.1...v0.1.2) (2026-02-16)


### Bug Fixes

* remove provenance from publishConfig for local publishing ([9ecfe2a](https://github.com/neel/ace-interview-prep/commit/9ecfe2ae42954faeb2d7918a47924a2412ce99ca))

## 0.1.1 (2026-02-16)


### Bug Fixes

* **init:** check file existence before write for correct Created/Overwrote message ([9ec57a1](https://github.com/neel/ace-interview-prep/commit/9ec57a1a2e4eb61f9e3f93d2cdf9ae1fa1601f45))
* **init:** merge devDependencies into existing package.json ([05b5f43](https://github.com/neel/ace-interview-prep/commit/05b5f43e3d629d536e69e4d2898a157287d8372c))

# Changelog

All notable changes to this project will be documented in this file.

This changelog is automatically managed by
[Release Please](https://github.com/googleapis/release-please).
