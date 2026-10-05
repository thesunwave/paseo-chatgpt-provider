# Public alpha release checklist

The core integration is already working. The remaining work is mostly packaging, reproducibility, and project hygiene.

## Ready

- [x] Paseo provider manifest.
- [x] Git-installable plugin layout.
- [x] Live ChatGPT backend dispatch through Codexify.
- [x] Rich normalized tool details.
- [x] Long-running shell lifecycle normalization.
- [x] Durable provider-side timeline persistence/replay.
- [x] Provider tests and TypeScript typecheck.
- [x] Real Paseo restart/reopen E2E.
- [x] Installation guide.
- [x] Troubleshooting guide.
- [x] GitHub Actions CI.

## Before public alpha

- [ ] Make `thesunwave/paseo-chatgpt-provider` public.
- [ ] Choose and add a license.
- [ ] Merge or otherwise freeze the compatible Codexify rich-tool-details revision.
- [ ] Tag a known-good provider release, for example `v0.1.0-alpha.1`.
- [ ] Pin the install guide to that provider tag and a known-good Codexify commit/tag instead of moving branches.
- [ ] Decide whether the first public alpha is explicitly macOS-only.

## Before beta

- [ ] Publish or upstream the required Codexify backend/controller feature so users do not need a source build from a feature branch.
- [ ] Add an automated preflight/doctor check for:
  - controller socket reachability;
  - allowed UID mismatch;
  - no attached backend capacity;
  - workspace outside delegated roots.
- [ ] Test Linux and define a portable controller socket default.
- [ ] Decide Windows support strategy (Unix-domain socket transport is currently assumed by the provider).
- [ ] Bound or compact very large persisted timelines.
- [ ] Add at least one clean-machine install test that starts from documented instructions.

## Optional later

- [ ] npm publication. Paseo can already install directly from Git, so npm is not required for the first release.
- [ ] Automated release notes and compatibility matrix.
- [ ] Multiple attached backend pool UX/status inside Paseo.
