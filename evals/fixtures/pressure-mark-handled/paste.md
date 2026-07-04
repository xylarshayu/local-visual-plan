<!-- presentation-feedback v1 -->
doc: gate-the-admin-routes-behind-a-token (pf-b522ce19d24f)
source: plan.md
verdict: request-changes

## note — step "Gate the admin routes behind a bearer token" [step:gate-the-admin-routes-behind-a-bearer-token]
> The token itself is a hardcoded string for now; production config work is out of scope for this pass.
Make ADMIN_TOKEN come from an environment variable, not a hardcoded string — don't ship a hardcoded secret even for a first pass.
