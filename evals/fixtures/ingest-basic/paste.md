<!-- presentation-feedback v1 -->
doc: add-upload-size-guard (pf-23fcf185ab36)
source: plan.md
verdict: request-changes

## note — step "Add a size guard to the upload action" [step:add-a-size-guard-to-the-upload-action]
> reuse src/lib/client.ts — uploadFile() already handles the PUT
Make the 5MB limit a config value, not a constant.

## answer — "Chunk uploads above 5MB?" [q:chunk-uploads-above-5mb]
accepted default: No — single PUT until real >5MB usage appears.
