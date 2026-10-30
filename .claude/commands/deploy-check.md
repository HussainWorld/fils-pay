---
description: Check the live Dilmune deployment after a push to main
---
1. `gh run list --workflow deploy.yml --limit 1` and watch it to completion.
2. Check `http://139.59.57.131/healthz`, `/dashboard/login`, `/admin/login` return 200.
3. Confirm the served asset hashes changed (new build is live).
Do not sign in on production with real or seed credentials; report what you checked.
