---
description: Pre-push checklist — run before every git push
---

// turbo-all

1. Run type checker:
```bash
bun run typecheck
```

2. Run linter with auto-fix:
```bash
bun run lint:fix
```

3. Run tests:
```bash
bun run test
```

4. Stage any formatting changes from lint:fix:
```bash
git add -A
```

5. If there are staged changes, amend the last commit:
```bash
git diff --cached --quiet || git commit --amend --no-edit
```
