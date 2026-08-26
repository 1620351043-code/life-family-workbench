import fs from 'node:fs/promises';

const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

function readOption(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tag = readOption('tag') || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
const requestedEnvironment = readOption('env') || process.env.RELEASE_ENV;

if (!tag) {
  console.log('release tag check: SKIP (no release tag supplied)');
  process.exit(0);
}

const match = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(tag);
if (!match) {
  throw new Error(`invalid release tag: ${tag}; expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N`);
}

const [, major, minor, patch, rc] = match;
const coreVersion = `${major}.${minor}.${patch}`;
if (packageJson.version !== coreVersion) {
  throw new Error(`package.json version ${packageJson.version} does not match tag core version ${coreVersion}`);
}

const inferredEnvironment = rc ? 'staging' : 'production';
const environment = requestedEnvironment || inferredEnvironment;
if (!['staging', 'production'].includes(environment)) {
  throw new Error(`invalid release environment: ${environment}; expected staging or production`);
}

if (environment === 'staging' && !rc) {
  throw new Error(`staging requires an RC tag, received ${tag}`);
}
if (environment === 'production' && rc) {
  throw new Error(`production requires a stable tag, received ${tag}`);
}

console.log(`release tag check: PASS (${tag} -> ${environment}; package ${packageJson.version})`);
