import fs from 'node:fs/promises';
import path from 'node:path';
import { generateOpenApiSpec } from '../src/apiSchemas.ts';
import { SUPPORTED_LANGUAGES } from '../src/i18n/types.ts';

async function main() {
  const apiDir = path.resolve(process.cwd(), 'docs', 'api');
  await fs.mkdir(apiDir, { recursive: true });

  for (const lang of SUPPORTED_LANGUAGES) {
    const spec = generateOpenApiSpec(undefined, lang);
    const localizedPath = path.join(apiDir, `openapi.${lang}.json`);
    const serialized = `${JSON.stringify(spec, null, 2)}\n`;
    await fs.writeFile(localizedPath, serialized, 'utf-8');
    if (lang === 'en') {
      await fs.writeFile(path.join(apiDir, 'openapi.json'), serialized, 'utf-8');
    }
    console.log(
      `Exported OpenAPI ${spec.openapi} [${lang.toUpperCase()}] (${Object.keys(spec.paths ?? {}).length} paths) -> ${localizedPath}`
    );
  }
}

main().catch((err) => {
  console.error('Failed to export OpenAPI spec:', err);
  process.exit(1);
});
