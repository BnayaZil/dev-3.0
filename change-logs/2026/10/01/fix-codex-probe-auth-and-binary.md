Short: Picker filter respects login and binary

The model-picker availability filter now probes the same Codex binary and account a launch actually uses — honoring a custom binary path and a preset's baseCommandOverride, and the selected account's CODEX_HOME — and treats a logged-out Codex home as "unknown" instead of trusting the bundled catalog it prints. So models are no longer wrongly greyed for users on a custom binary, a managed account, or a logged-out CLI. Follow-up to the model-picker filter review.
