# Session Debrief Selection Matrix & Zero-Raw-JSON Tape CLI

> Read on-demand at Checkpoint 2 (Post-Exploration Debrief) or when creating negative/boundary/persona Session Tape variants.

## 1. Checkpoint 2: Post-Exploration Session Debrief
Present this concise debrief so the Quality Engineer picks **1 critical scenario at a time**:

### A. Discovered Flow & API Map
- **Portals & Routes:** `<Portal A: /route-1 -> /route-2>` ➔ `<Portal B: /agent/referrals>`
- **Components & Captured State:** `<ComponentCandidates>` + `<capturedVariables>`
- **Observed APIs:** `<METHOD> <urlPattern> (<status>) -> <clientCandidate> <schema>`

### B. Defects & Shards Updated
- Defects written to `defects/DEFECT-<timestamp>.md`.
- Domain shards updated in `.agents/domain/shards/<feature>.md` (or `domains/<squad>/shards/<feature>.md`, `≤ 150` lines) + `npm run domain:graph -- --seed-from-tapes`.

### C. Candidate Coverage Matrix (1 Test at a Time)
| # | Tags | Candidate Scenario ID | Charter | Scope & Assertions | Pacing |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `@p0 @smoke` | `<feature>-e2e-happy-path` | `happy-path-baseline` | Full flow + dynamic state verification | Automate 1st |
| **2** | `@p0 @smoke` | `<feature>-cross-portal` | `cross-portal-handoff` | Customer referral + Agent approval | Automate 2nd |
| **3** | `@p1 @regression` | `<feature>-api-contract` | `api-contract` | Backend API contract & precondition seeder | Automate 3rd |
| **4** | `@p1 @regression` | `<feature>-validation-bounds` | `boundary-analysis` | Negative/boundary guards & error banner | Automate 4th |

Ask: *"Which **single scenario** (`1`–`4`) should I emit as a Session Tape and compile/verify first via `/02-solid-architect <scenario-id>`?"*

## 2. Token-Efficient Tape Operations (`npx cortex tape`)
Never read `.agents/domain/session-tape.schema.json` (4.5k tok) or hand-write 240-line tape JSON. Use `npx cortex tape`:
```bash
npx cortex tape list                                     # 1 line per tape
npx cortex tape show <scenario-id>                       # ~150-tok DSL summary
npx cortex tape clone <src-id> <new-id> \
  --title "Locked-out user login error" \
  --charter multi-persona-auth \
  --tags "@p1,@smoke,@negative" \
  --persona-role locked_out --persona-builder UserBuilder.lockedOutUser
npx cortex tape patch <new-id> \
  --set-step 2 inputDataRef="UserBuilder.lockedOutUser().username" \
  --add-expect "loginPage.form.errorBanner|toContainText|UserBuilder.lockedOutUser().expectedError"
```
Every `clone` and `patch` auto-validates against `validate-tapes.mjs` before writing.
