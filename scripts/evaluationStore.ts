import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvaluationConfig, EvaluationInput, EvaluationRun } from '@/lib/evaluationLab';

export class EvaluationStoreError extends Error {}
export class EvaluationConflictError extends EvaluationStoreError {}
export class IncompleteEvaluationError extends EvaluationStoreError {}

export interface StoredEvaluationRun {
  schemaVersion: '1';
  contract: EvaluationConfig;
  run: EvaluationRun;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashEvaluationInput(input: EvaluationInput): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export function hashEvaluationConfig(config: EvaluationConfig): string {
  const { configurationId: _configurationId, ...withoutId } = config;
  return createHash('sha256').update(stableJson(withoutId)).digest('hex');
}

export function assertConfigurationIntegrity(config: EvaluationConfig): void {
  if (hashEvaluationConfig(config) !== config.configurationId) {
    throw new IncompleteEvaluationError(
      `Evaluation configuration hash mismatch: ${config.configurationId}`,
    );
  }
}

export function comparableOutputs(run: EvaluationRun): unknown {
  return {
    decisions: run.decisions,
    coverage: run.coverage,
    observationPeriod: run.observationPeriod,
  };
}

export function stableSerialize(value: unknown): string {
  return stableJson(value);
}

function pathsFor(store: string, runKey: string, configurationId: string) {
  const root = resolve(store);
  for (const [label, value] of [
    ['run key', runKey],
    ['configuration ID', configurationId],
  ] as const) {
    if (!value || value.includes('/') || value.includes('\\') || value.includes('\0')) {
      throw new EvaluationStoreError(`Invalid ${label}`);
    }
  }
  return {
    root,
    run: join(root, 'runs', `${encodeURIComponent(runKey)}.json`),
    contract: join(root, 'contracts', `${encodeURIComponent(configurationId)}.json`),
  };
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicCreateOrVerify(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(path, 'utf8');
      if (existing !== content) {
        throw new EvaluationConflictError(`Conflicting retry for ${path}`);
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export async function saveEvaluationRun(run: EvaluationRun, store: string): Promise<void> {
  assertConfigurationIntegrity(run.configuration);
  const paths = pathsFor(store, run.runKey, run.configuration.configurationId);
  const contract = `${stableSerialize(run.configuration)}\n`;
  const stored: StoredEvaluationRun = {
    schemaVersion: '1',
    contract: run.configuration,
    run,
  };
  await atomicCreateOrVerify(paths.contract, contract);
  await atomicCreateOrVerify(paths.run, `${JSON.stringify(stored, null, 2)}\n`);
}

async function assertNoIncompleteArtifacts(root: string): Promise<void> {
  const readDirectory = async (directory: string) => {
    const path = join(root, directory);
    const names = await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (names.some((name) => name.includes('.tmp-'))) {
      throw new IncompleteEvaluationError(`Incomplete evaluation write found in ${path}`);
    }
  };
  await Promise.all([readDirectory('runs'), readDirectory('contracts')]);
}

export async function loadEvaluationRun(
  runKey: string,
  store: string,
): Promise<StoredEvaluationRun> {
  const paths = pathsFor(store, runKey, 'unused');
  await assertNoIncompleteArtifacts(paths.root);
  const content = await readExisting(paths.run);
  if (!content) throw new EvaluationStoreError(`No saved evaluation run for ${runKey}`);
  let stored: StoredEvaluationRun;
  try {
    stored = JSON.parse(content) as StoredEvaluationRun;
  } catch {
    throw new IncompleteEvaluationError(`Evaluation run is not valid JSON: ${paths.run}`);
  }
  if (
    stored.schemaVersion !== '1' ||
    !stored.contract ||
    !stored.run ||
    stableSerialize(stored.contract) !== stableSerialize(stored.run.configuration)
  ) {
    throw new IncompleteEvaluationError(
      `Evaluation run is incomplete or contract-mismatched: ${paths.run}`,
    );
  }
  assertConfigurationIntegrity(stored.contract);
  const contractPath = pathsFor(store, runKey, stored.contract.configurationId).contract;
  const contractContent = await readExisting(contractPath);
  let persistedContract: unknown;
  try {
    persistedContract = contractContent ? JSON.parse(contractContent) : null;
  } catch {
    throw new IncompleteEvaluationError(`Evaluation contract is not valid JSON: ${contractPath}`);
  }
  if (!contractContent || stableSerialize(persistedContract) !== stableSerialize(stored.contract)) {
    throw new IncompleteEvaluationError(
      `Evaluation contract is missing or mismatched: ${contractPath}`,
    );
  }
  return stored;
}

export async function loadEvaluationRuns(store: string): Promise<StoredEvaluationRun[]> {
  const root = resolve(store);
  await assertNoIncompleteArtifacts(root);
  const directory = join(root, 'runs');
  const names = (
    await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })
  ).filter((name) => name.endsWith('.json'));
  const runs = await Promise.all(
    names.map(async (name) => {
      const runKey = decodeURIComponent(name.slice(0, -'.json'.length));
      return loadEvaluationRun(runKey, store);
    }),
  );
  const referencedContracts = new Set(
    runs.map(({ contract }) => `${encodeURIComponent(contract.configurationId)}.json`),
  );
  const contractDirectory = join(root, 'contracts');
  const contractNames = (
    await readdir(contractDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })
  ).filter((name) => name.endsWith('.json'));
  if (contractNames.some((name) => !referencedContracts.has(name))) {
    throw new IncompleteEvaluationError(
      `Unreferenced evaluation contract found in ${contractDirectory}`,
    );
  }
  return runs;
}
