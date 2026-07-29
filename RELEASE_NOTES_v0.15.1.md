# Bobbit v0.15.1

Upgrading from v0.15.0. This release adds Claude Opus 5 support and dedicated verifiable bug reviews, while improving model-selection and multi-repository Git status reliability.

## ✨ New Features

* 🤖 **Claude Opus 5 & Pi 0.82.1**: Bobbit now exposes Claude Opus 5 through the authoritative Pi model catalog. Provider, model, and thinking-level selections travel together through sessions, delegates, team workers, restarts, and recovery, with safe rollback when a requested runtime tuple cannot be verified.

* 🔍 **Verifiable bug-hunt reviews**: Built-in implementation workflows now include a dedicated read-only reviewer focused on reproducible bugs in the current branch diff.

## 🐛 Bug Fixes

* 🧩 **Accurate polyrepo Git status**: Goal and session widgets now retain named component repositories, aggregate partial results conservatively, survive team-lead restart recovery, and avoid hiding valid component status when the project container itself is not a Git repository.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
