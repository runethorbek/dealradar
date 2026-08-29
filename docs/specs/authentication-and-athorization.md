# Authentication and Authorization

## Goal

Protect DealRadar so only the owner can use user-facing write functionality.

Authentication should add minimal friction in normal daily use.

## Scope

Protect user-facing DealRadar functionality that changes persistent state.

This includes:

- updating preferences;
- submitting product feedback;
- future user-triggered write operations.

System-to-system endpoints must keep their existing authentication model where appropriate.

## User experience

The owner should be able to sign in using an external identity provider such as Google or GitHub.

After successful sign-in, the session should remain valid for an extended period so normal daily use does not require repeated login.

Expected behavior:

- first visit on a new browser/device may require sign-in;
- normal refreshes and browser restarts should not require sign-in again while the session remains valid;
- an explicit logout ends the session;
- expired or invalid sessions require authentication again.

## Authorization model

DealRadar is currently a single-user application.

Only one explicitly allowed identity may perform authenticated user operations.

Being authenticated is not sufficient by itself.

The authenticated identity must also match the configured allowed user.

## Protected user operations

The following operations must require an authenticated and authorized user:

- `POST /api/preferences`
- `POST /api/product-feedback`

Future endpoints that modify user-owned DealRadar state should follow the same rule unless explicitly documented otherwise.

## Backend enforcement

Authorization must be enforced server-side.

Hiding UI controls or pages is not sufficient protection.

A caller that invokes a protected API endpoint directly must still be rejected unless authenticated and authorized.

Expected responses:

- no valid authentication → `401 Unauthorized`
- authenticated but not allowed → `403 Forbidden`
- authenticated and allowed → existing endpoint behavior continues

## System-to-system authentication

Authentication for browser users must not replace existing machine-to-machine authentication.

For example:

- `/api/import-deals` continues to use its existing bearer/API-key authentication;
- GitHub Actions must not require an interactive user session.

User authentication and system authentication are separate security boundaries.

## Session requirements

Sessions should:

- use secure server-managed authentication;
- be persisted using secure cookies;
- not expose authentication secrets to client-side JavaScript unnecessarily;
- remain valid long enough to avoid repeated daily login;
- expire or become invalid after logout.

The exact session duration is an implementation decision, but the intended UX is low-friction persistent login.

## Security constraints

- Do not implement custom password storage.
- Do not store authentication secrets in the repository.
- Do not rely on client-side checks for authorization.
- Do not weaken the existing authentication of system endpoints.
- Do not expose database credentials or provider secrets to the browser.

## Acceptance criteria

1. An unauthenticated request to `POST /api/preferences` returns `401` and does not modify the database.
2. An authenticated but unauthorized identity receives `403` and does not modify the database.
3. The allowed user can update preferences successfully.
4. The same protection applies to `POST /api/product-feedback`.
5. Direct API calls cannot bypass authorization.
6. Existing authenticated system-to-system imports continue working unchanged.
7. The owner remains signed in across normal page refreshes and browser restarts while the session is valid.
8. Authentication and authorization behavior has deterministic tests where practical.

## Verification

Verify at minimum:

- unauthenticated direct API request;
- authenticated unauthorized request;
- authenticated authorized request;
- browser refresh with an existing session;
- logout followed by a protected request;
- existing `/api/import-deals` flow still succeeds with its current authentication.

## Explicitly out of scope

For the first version:

- multiple users;
- roles or permission levels;
- password-based login;
- account management;
- user registration;
- organization support.

## Implementation
- [#4](https://github.com/runethorbek/dealradar/issues/4)
