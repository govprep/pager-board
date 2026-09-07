// Offline source guardrails using the installed TypeScript parser. This is not
// ESLint: no lint engine is installed, and Next 16 removed `next lint`.
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let errors = 0;
let checked = 0;
function report(file, node, message) {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  console.error(`${file.fileName}:${line + 1}:${character + 1} ${message}`);
  errors++;
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (!/\.(?:[cm]?js|tsx?)$/.test(path) || path.endsWith(".d.ts")) continue;
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    checked++;
    for (const diagnostic of file.parseDiagnostics) {
      console.error(`${path}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
      errors++;
    }
    const client = file.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use client");
    function visit(node) {
      if (ts.isDebuggerStatement(node)) report(file, node, "Remove debugger statements");
      if (client && ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "process.env" && !node.name.text.startsWith("NEXT_PUBLIC_") && node.name.text !== "NODE_ENV") {
        report(file, node, "Private environment variable in a client component");
      }
      if (client && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /(?:^|\/)(?:supabase|supabase-server|access)$/.test(node.moduleSpecifier.text)) {
        report(file, node, "Server module imported by a client component");
      }
      if (ts.isJsxAttributes(node)) {
        const names = new Set();
        for (const prop of node.properties) {
          if (!ts.isJsxAttribute(prop)) continue;
          const name = prop.name.getText(file);
          if (names.has(name)) report(file, prop, `Duplicate JSX attribute: ${name}`);
          names.add(name);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
}
for (const dir of ["app", "components", "lib", "feeder", "scripts", "public"]) walk(dir);
console.log(`Offline source lint: ${checked} files, ${errors} errors`);
process.exitCode = errors ? 1 : 0;
