/**
 * Fixture-file patcher for `compile-tape.mjs` (#78).
 *
 * Supports:
 *   - `export interface AppFixtures {` and `export interface AppFixtures extends BaseFixtures, ... {`
 *   - `base.extend<AppFixtures>({` and nested generics such as
 *     `base.extend<Omit<AppFixtures, keyof BackendFixtures>>({` (balanced angle-bracket scan)
 *   - Non-generic `base.extend({` fallback
 *   - Fails loudly if either insertion point cannot be located so `compile-tape` never writes
 *     a broken fixture file with dangling unused imports.
 */

const INTERFACE_HEADER_RE = /(export\s+interface\s+[A-Za-z0-9_]+(?:\s+extends\s+[^{]+)?\s*\{)/;

export function insertIntoFixtureInterface(content, interfaceLines) {
  const match = INTERFACE_HEADER_RE.exec(content);
  if (!match) {
    return { matched: false, content };
  }
  const insertAt = match.index + match[0].length;
  return {
    matched: true,
    content: `${content.slice(0, insertAt)}\n${interfaceLines}${content.slice(insertAt)}`,
  };
}

export function insertIntoFixtureExtend(content, implLines) {
  const genericStartRe = /\.extend\s*</g;
  let m;
  while ((m = genericStartRe.exec(content)) !== null) {
    const openAngle = m.index + m[0].length - 1;
    let depth = 0;
    let closeAngle = -1;
    for (let i = openAngle; i < content.length; i++) {
      const ch = content[i];
      if (ch === '<') {
        depth++;
      } else if (ch === '>' && content[i - 1] !== '=') {
        depth--;
        if (depth === 0) {
          closeAngle = i;
          break;
        }
      }
    }
    if (closeAngle === -1) continue;
    const afterGeneric = content.slice(closeAngle + 1);
    const openBraceMatch = /^\s*\(\s*\{/.exec(afterGeneric);
    if (openBraceMatch) {
      const insertAt = closeAngle + 1 + openBraceMatch[0].length;
      return {
        matched: true,
        content: `${content.slice(0, insertAt)}\n${implLines}${content.slice(insertAt)}`,
      };
    }
  }

  const plainExtendMatch = /\.extend\s*\(\s*\{/.exec(content);
  if (plainExtendMatch) {
    const insertAt = plainExtendMatch.index + plainExtendMatch[0].length;
    return {
      matched: true,
      content: `${content.slice(0, insertAt)}\n${implLines}${content.slice(insertAt)}`,
    };
  }

  return { matched: false, content };
}

export function extendFixtureContent(
  fixtureContent,
  { importLines = '', interfaceLines, implLines, fixtureRelPath = 'src/fixtures/app.fixture.ts' }
) {
  const hasExportInterface = /\bexport\s+interface\s+/.test(fixtureContent);
  const ifaceResult = insertIntoFixtureInterface(fixtureContent, interfaceLines);
  if (hasExportInterface && !ifaceResult.matched) {
    throw new Error(
      `Failed to extend fixture '${fixtureRelPath}': could not locate an 'export interface <Name> [extends ...] {' declaration.`
    );
  }

  const extendResult = insertIntoFixtureExtend(ifaceResult.content, implLines);
  if (!extendResult.matched) {
    throw new Error(
      `Failed to extend fixture '${fixtureRelPath}': could not locate a '.extend<...>({ ' or '.extend({' provider block.`
    );
  }

  return importLines ? `${importLines}\n${extendResult.content}` : extendResult.content;
}
