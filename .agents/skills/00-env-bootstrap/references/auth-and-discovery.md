# Auth Persistence (`storageState`) & Unfamiliar App Discovery Playbook

Use this reference when executing `00-env-bootstrap` against complex integrated deployed applications.

---

## 1. Reusable Persona Authentication (`.auth/<persona>.json`)

Complex enterprise applications frequently use SSO (Okta/Azure AD/Auth0), MFA, or heavy token initialization that makes logging in via UI on every test slow and brittle.

### Step-by-Step Session Capture
1. Ensure `.auth/` is listed in `.gitignore` so live tokens/cookies are never committed.
2. Open the target environment in headed mode:
   ```bash
   npx playwright-cli -s=auth open <baseUrl> --headed
   ```
3. **Automated Login:** If standard credentials exist in `src/data/user.builder.ts` (via `process.env.TEST_USERNAME` / `process.env.TEST_PASSWORD`), fill and submit using `.playwright-cli/page-*.yml` refs.
4. **Interactive SSO / MFA Assisted Login:** If the app requires human MFA/SSO approval, prompt the engineer:
   > *"Please complete the SSO/MFA challenge in the opened browser window and reply `ready` once you reach the authenticated landing page."*
5. Once authenticated, capture the active cookies/storage mechanism in `.agents/domain/domain-memory.md` (Section 1: `Session Mechanism`) and reference `.auth/<persona>.json` in the Session Tape `persona.storageStatePath`.

---

## 2. Unfamiliar Application Map Discovery

When a Quality Engineer points the agent at a complex deployed application for the first time:
1. Inspect the post-login `.playwright-cli/page-*.yml` snapshot.
2. Extract primary functional modules from:
   - `role="navigation"` links and menus
   - Dashboard cards, tabs (`role="tab"`), and primary CTA buttons
   - URL route patterns (`/orders`, `/billing`, `/settings`, `/inventory.html`)
3. Present a concise **Discovered Application Map Table** to the engineer:

| Module / Feature | Entry Route | Key Landmarks / Forms | Suggested Shard Path |
| :--- | :--- | :--- | :--- |
| `<Feature Name>` | `<Route>` | `<Forms / Tables / Modals>` | `.agents/domain/shards/<feature>.md` |

4. Upon confirmation, register the discovered modules in `.agents/domain/domain-memory.md` (Section 3: **Feature Shard Index**) and hand off to `/01-cli-explorer`.
