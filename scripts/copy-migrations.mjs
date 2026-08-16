// tsc emits .js and nothing else, so the migration .sql files and their
// meta/_journal.json do not follow the code into dist/. src/lib/db/migrate.ts
// resolves its folder relative to its own module location, which means the
// compiled migrate.js needs the migrations sitting beside it.
//
// Done here, in the build, rather than in the Dockerfile: dist/ should be
// complete wherever it was produced. Copying only in the image would leave
// `node dist/lib/db/migrate.js` broken everywhere else and working in exactly
// one place, which is the CWD-dependence we just removed wearing a new hat.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "src", "lib", "db", "migrations");
const to = join(root, "dist", "lib", "db", "migrations");

if (!existsSync(from)) {
  console.error(`copy-migrations: nothing at ${from}`);
  process.exit(1);
}

cpSync(from, to, { recursive: true });
console.log(`copy-migrations: ${from} -> ${to}`);
