# Defect Report Template

When `01-cli-explorer` detects an unhandled console error, network 5xx failure, or business rule violation, create `defects/DEFECT-<YYYY-MM-DDTHH-mm-ssZ>-<slug>.md` using this structure:

```markdown
# DEFECT: <Concise Title>

- **Timestamp:** <ISO-8601>
- **Charter:** `<charter-name>`
- **Persona:** `<persona-role>` (`<DataBuilderRef>`)
- **URL:** `<url>`
- **Severity:** Critical | High | Medium | Low

## 1. Summary
<1-2 sentence explanation of the observed failure vs. domain-memory.md invariant.>

## 2. Reproduction Steps (Semantic Locators)
1. Navigate to `<url>`
2. Interact with `<ParentScope> -> <SemanticLocator>` (`cliRef: eXX`)
3. Observe failure state

## 3. Expected vs. Actual Behaviour
- **Expected:** <Expected state from domain-memory.md>
- **Actual:** <Actual observed UI/network/console behaviour>

## 4. Evidence & Diagnostics
- **Console Errors:** `<output of playwright-cli console error>`
- **Snapshot Pointer:** `.playwright-cli/page-<timestamp>.yml`
- **Screenshot:** `defects/screenshots/<slug>.png`
```
