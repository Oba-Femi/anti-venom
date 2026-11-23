/**
 * Build pipeline: bundles TypeScript with esbuild, compiles filter lists into
 * static DNR rulesets, renders icons, and assembles dist/ as a loadable
 * unpacked extension.
 *
 *   node scripts/build.ts            production build (minified)
 *   node scripts/build.ts --dev      development build (sourcemaps, debug logs)
 *   node scripts/build.ts --watch    rebuild on change (implies nothing about --dev)
 */
import { build, context, type BuildOptions } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { compileBundledLists, type RulesetResource } from './compile-filters.ts';
import { generateIcons } from './icons.ts';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const watching = args.has('--watch');

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };

const common: BuildOptions = {
  bundle: true,
  target: 'chrome121',
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  legalComments: 'none',
  define: { __DEV__: JSON.stringify(dev) },
  logLevel: 'warning',
};

const entries: BuildOptions[] = [
  { ...common, entryPoints: [join(ROOT, 'src/background/index.ts')], outfile: join(DIST, 'background.js'), format: 'esm' },
  { ...common, entryPoints: [join(ROOT, 'src/content/cosmetic.ts')], outfile: join(DIST, 'content.js'), format: 'iife' },
  { ...common, entryPoints: [join(ROOT, 'src/popup/popup.ts')], outfile: join(DIST, 'popup.js'), format: 'iife' },
  { ...common, entryPoints: [join(ROOT, 'src/app/main.ts')], outfile: join(DIST, 'app.js'), format: 'iife' },
  { ...common, entryPoints: [join(ROOT, 'src/content/gpc.ts')], outfile: join(DIST, 'gpc.js'), format: 'iife' },
  { ...common, entryPoints: [join(ROOT, 'src/ui/theme-boot.ts')], outfile: join(DIST, 'theme.js'), format: 'iife' },
];

async function writeManifest(resources: RulesetResource[]): Promise<void> {
  const template = JSON.parse(await readFile(join(ROOT, 'static/manifest.json'), 'utf8')) as Record<string, unknown>;
  template.version = pkg.version;
  (template.declarative_net_request as Record<string, unknown>).rule_resources = resources;
  await writeFile(join(DIST, 'manifest.json'), JSON.stringify(template, null, 2));
}

async function copyStatic(): Promise<void> {
  await cp(join(ROOT, 'static'), DIST, {
    recursive: true,
    filter: (src) => !src.endsWith('manifest.json'),
  });
}

async function fullBuild(): Promise<RulesetResource[]> {
  const t0 = performance.now();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  console.log(`Building Anti-Venom ${pkg.version} (${dev ? 'development' : 'production'})`);
  console.log('Compiling filter lists:');
  const resources = await compileBundledLists(DIST);
  await Promise.all([...entries.map((e) => build(e)), copyStatic(), generateIcons(DIST)]);
  await writeManifest(resources);
  console.log(`Done in ${Math.round(performance.now() - t0)} ms → ${DIST}`);
  return resources;
}

const resources = await fullBuild();

if (watching) {
  const contexts = await Promise.all(entries.map((e) => context(e)));
  await Promise.all(contexts.map((c) => c.watch()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  fsWatch(join(ROOT, 'static'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void copyStatic()
        .then(() => writeManifest(resources))
        .then(() => console.log('static files updated'));
    }, 100);
  });
  console.log('Watching for changes… (filter lists are compiled once; rerun build after filters:fetch)');
}
