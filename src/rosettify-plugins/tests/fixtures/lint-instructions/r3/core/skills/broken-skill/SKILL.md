---
name: broken-skill
description: "Carries one broken reference and one working one, for the alias-target-exists rule."
tags: ["fixture"]
---

This one resolves: READ SKILL FILE `assets/exists.md`.

This one does not: USE SKILL `does-not-exist`.

Nor does this one: READ SKILL FILE `assets/missing.md`.
