<!-- presentation-feedback v1 -->
doc: add-upload-size-guard (pf-23fcf185ab36)
source: plan.md
verdict: request-changes

## note — step "Add retry logic to the upload action" [step:add-retry-logic-to-the-upload-action]
> retries failed uploads up to 3 times before giving up
Please make the retry count configurable too.

## answer — "Chunk uploads above 5MB?" [q:chunk-uploads-above-5mb]
accepted default: No — single PUT until real >5MB usage appears.
