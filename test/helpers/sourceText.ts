import fs from 'fs';
import path from 'path';

// The mutation gate runs tests in <checkout>/.stryker-tmp/sandbox-*/, where src holds instrumented text; a test that
// reads a source file's text reads the checkout's copy.
export function readSourceText(fromDir: string, relativePath: string): string {
  const resolved = path.resolve(fromDir, relativePath);
  const parts = resolved.split(/[\\/]/);
  let at = -1;
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === '.stryker-tmp' && parts[i + 1].startsWith('sandbox-')) { at = i; break; }
  }
  if (at < 0) return fs.readFileSync(resolved, 'utf8');
  const mapped = [...parts.slice(0, at), ...parts.slice(at + 2)].join(path.sep);
  if (!fs.existsSync(mapped)) throw new Error(`readSourceText: ${resolved} is in a mutation sandbox, and its checkout copy ${mapped} does not exist`);
  return fs.readFileSync(mapped, 'utf8');
}
