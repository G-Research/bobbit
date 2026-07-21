# Bobbit v0.14.2

Upgrading from v0.14.1. This release makes sessions faster and smoother to revisit, strengthens browser authentication, and brings review and reset controls closer to active workflow gates.

## ✨ New Features

* ⚡ **Faster session loading & recovery**: Large and archived session histories load with substantially less work, while startup recovery now keeps expensive filesystem and model checks bounded so the gateway stays responsive.

* 🔄 **Gate reset recovery**: Resetting a workflow gate now reopens a completed active goal, rearms its team lead, and updates the goal status immediately so work can continue normally.

* ✅ **Reviews on gate cards**: Active human sign-off reviews can be launched directly from goal status, live verification, and gate inspection cards, with the review action placed beside the relevant step name.

* 🔐 **Stateless browser authentication**: Browser cookies are now securely signed instead of stored in a server-side registry, improving restart and multi-process reliability while preserving preview, sandbox, and operator authentication behavior.

* 🏷️ **Visible build identity**: Settings now shows the running Bobbit version and, for source checkouts, the short commit SHA so operators can quickly confirm which build is active.

## 🐛 Bug Fixes

* 📱 **Portrait session navigation**: Returning to a healthy session from the portrait back-to-list flow now reuses the correct live panel without an unnecessary loader or replacement connection, while stale and mismatched cache entries are safely discarded.

---

🤖 Generated with [Bobbit](https://github.com/SuuBro/bobbit)
