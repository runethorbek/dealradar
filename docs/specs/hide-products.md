# Hide Products

## Problem Statement

DealRadar currently offers only preference feedback: Like and Not for me. A
user also needs to defer products whose relevance is undecided. These products
should remain tracked and retain their existing evaluation eligibility, but
they should not appear in the default product view or be selected as product
recommendations.

## Solution

Add a separate, reversible visibility state for products. A user can Hide a
product without creating or changing a preference-learning signal. Hidden
products are excluded from the default Visible view and product recommendation
selection while remaining part of the tracked product set.

Provide a default Visible view and a separate Hidden view. Unhide is always an
explicit action. Like and Not for me never change visibility. An explicitly
requested hidden product remains pinned in the current view and is clearly
marked Hidden.

## User Stories

1. As a user, I want to Hide and explicitly Unhide a product, so that I can reversibly defer products I have not decided about.
2. As a user, I want the default dashboard to exclude hidden products, so that deferred products do not clutter my normal view.
3. As a user, I want a Hidden view, so that I can review and Unhide deferred products.
4. As a user, I want the Hidden view to compose with existing source filters and sort options, so that I can review deferred products using familiar controls.
5. As a user, I want the selected visibility view represented in the URL, so that I can bookmark the Hidden view.
6. As a user, I want an explicitly requested hidden product to remain pinned and clearly marked Hidden, so that direct links and bookmarks remain understandable and usable.
7. As a user, I want Like and Not for me to remain independent from visibility, so that preference feedback neither hides nor unhides a product.
8. As a user, I want hiding to leave existing import, evaluation-eligibility, scoring, and sorting behavior unchanged, so that Hide remains a presentation decision.
9. As a user, I want hidden products excluded before the top product recommendation is selected, while operational import and scan information is still delivered.
10. As a user, I want Unhide to restore eligibility for future product recommendations without immediately creating a notification.
11. As a user, I want a failed Hide or Unhide request to leave the displayed state unchanged and allow me to retry.
12. As a user, I want all existing products to start visible when this feature is introduced, so that the migration does not unexpectedly remove products from my dashboard.

## Implementation Decisions

- Visibility is a separate domain concern from preference feedback.
- Product visibility is persisted as a boolean hidden state. Existing products default to visible.
- The schema change is additive and preserves existing products, price history, evaluations, and feedback.
- Visibility changes use a separate API contract from the existing preference-feedback API.
- The visibility API assigns an explicit desired state for a validated product identifier and returns the persisted state.
- Repeated requests for the same desired visibility state are idempotent.
- Malformed requests and invalid identifiers return a client error, missing products return a not-found response, and configuration or persistence failures return a server error.
- The dashboard supports a default Visible view and a Hidden view. An All view is deferred.
- The selected visibility view is encoded in the URL and composes with existing source and sort query parameters.
- Visibility filtering happens before sorting and the existing result limit.
- An explicitly requested product remains pinned even when it does not match the selected visibility view. A pinned hidden product is clearly marked Hidden.
- Like and Not for me remain preference signals and never change visibility.
- Hide and Unhide preserve existing Like or Not for me feedback.
- Successful visibility changes refresh the server-rendered view. Ordinary cards disappear when they no longer match the selected view; no optimistic collection management is required.
- Failed visibility changes leave the displayed card and active filters unchanged and permit the same action to be retried.
- Hiding does not change import, snapshot, evaluation-candidate, scoring, or sorting behavior.
- Hidden products are excluded after evaluation and before the highest-ranked product recommendation is selected. If the highest-ranked evaluated product is hidden, the next eligible visible product is considered.
- If no visible recommendation remains, the operational import summary and scan warnings are still delivered.
- Unhide restores eligibility for later recommendation selection but does not itself trigger evaluation or notification.
- The domain glossary defines Visibility, Hide, and Unhide and distinguishes them from preference feedback.

## Testing Decisions

- Tests verify observable behavior and domain outcomes rather than SQL query shape or component implementation details.
- No new database, route, React, or mocking test infrastructure is introduced for this feature.
- Deterministic Node tests cover extracted visibility parsing and selection rules, direct-product inclusion behavior, and recommendation selection when higher-ranked products are hidden.
- Existing notification tests verify that operational summaries and scan warnings remain when no visible recommendation is available.
- Manual acceptance checks cover applying the migration, Hide and Unhide persistence, Visible and Hidden dashboard queries, source and sort composition, pinned direct links, filter-specific empty states, and API failure responses.
- Migration inspection verifies that existing products default to visible and existing product data and feedback are preserved.

## Implementation Progress

### Completed: import/evaluation tracer bullet

- [x] Carry persisted `hidden` state through import results, evaluation candidates, and evaluated recommendations.
- [x] Evaluate hidden and visible products under the existing eligibility, ordering, limit, and failure rules.
- [x] Exclude hidden products only after evaluation and before top-recommendation selection.
- [x] Return no recommendation when every evaluated product is hidden while preserving the operational import result.

Verified with deterministic tests covering both evaluation calls, visibility preservation during mapping, visible recommendation selection, and the all-hidden case.

### Completed: visibility persistence API

- [x] Migration 007 applied successfully.
- [x] Existing products defaulted to visible.
- [x] Hide and Unhide persisted correctly.
- [x] Repeated Hide remained state-idempotent.
- [x] `404` and `400` behavior verified.
- [x] A controlled non-production request with database configuration unavailable returned `500`.
- [x] `last_seen_at`, snapshots, feedback, and evaluations remained unchanged.

### Completed: dashboard visibility views

- [x] The Hidden view was empty for a source whose products were all visible.
- [x] Hiding a product removed it from ordinary Visible results and added it to the Hidden view.
- [x] A direct Visible link showed the hidden product exactly once with a Hidden label.
- [x] Switching between Visible and Hidden preserved the selected source and sort.
- [x] Unhiding the product restored its original Visible state and the source's empty Hidden view.

### Completed: dashboard visibility controls

- [x] Hide from Visible succeeded and removed the product after refresh.
- [x] The Hidden view showed the product with a Hidden label and an Unhide action.
- [x] Unhide succeeded and restored the product to Visible.
- [x] A direct-link hidden product appeared exactly once and behaved correctly after Unhide.
- [x] A failed visibility request left the card unchanged, showed a local error, and allowed a successful retry.
- [x] Source, sort, view, and product URL parameters remained unchanged across successful refreshes.

### MVP status

- [x] Ready for production rollout.

## Out of Scope

- An All visibility view.
- Total or per-view database counts.
- Recording when a product was hidden.
- Automatically changing visibility when Like or Not for me is selected.
- Optimistic client-side collection management.
- New database, route, React, or mocking test infrastructure.
- Changing the meaning or learning behavior of Like or Not for me.
- Automatically hiding products based on score, price, retailer, category, or age.
- Deleting products, price history, evaluations, or feedback.
- Changing existing import, snapshot, evaluation-eligibility, scoring, or sorting behavior for hidden products.
- Changing scraper behavior or the external import contract.
- Suppressing operational import summaries or scan warnings.
- Sending an immediate notification when a product is unhidden.
- Adding multiple users, per-user visibility, or authentication changes.
- Adding bulk Hide or Unhide operations.
- Adding a separate archive or deletion state.

## Further Notes

- The database migration must be applied manually to Neon; creating the migration file does not update the database automatically.
- Hidden is a deliberate visibility state, not a synonym for Not for me.
- Visible is the normal product view. Hidden is the deferred-product view.
- No issue-tracker publication was performed because no issue-tracker connector or ready-for-agent label vocabulary was available in the current session.
