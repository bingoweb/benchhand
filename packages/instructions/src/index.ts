import { createHash } from 'node:crypto';
import {
  lstat,
  open,
  readdir,
  readFile as readFileFromDisk,
  realpath,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

import type { WorkspaceId, WorkspaceRecord } from '@benchhand/contracts';
import { parseDocument } from 'yaml';

const MAX_SCOPE_DEPTH = 128;
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 1024 * 1024;
const MAX_STABLE_READ_ATTEMPTS = 3;
const MAX_SKILL_FRONTMATTER_BYTES = 64 * 1024;

export interface InstructionDocument {
  providerId: string;
  scopePath: string;
  sourceId: string;
  path: string | null;
  content: string;
  sha256: string;
}

export interface InstructionProviderContribution {
  sourceId: string;
  content: string;
  path?: string | null;
}

export interface InstructionProviderContext {
  workspace: WorkspaceRecord;
  workspaceRoot: string;
  scopePath: string;
  absoluteScopePath: string;
}

export interface InstructionProvider {
  id: string;
  precedence: number;
  resolveScope(context: InstructionProviderContext): Promise<InstructionProviderContribution[]>;
}

export interface InstructionsResolveRequest {
  workspaceId: WorkspaceId;
  scopePath?: string;
}

export interface InstructionsResolveResult {
  workspaceId: WorkspaceId;
  scopePath: string;
  scopes: string[];
  documents: InstructionDocument[];
}

export type SkillSourceKind =
  | 'project'
  | 'benchhand-user'
  | 'agents-user'
  | 'codex-user'
  | 'devspace-compat'
  | 'configured';

export interface SkillSummary {
  skillId: string;
  name: string;
  description: string;
  sourceId: string;
  sourceKind: SkillSourceKind;
  skillDirectoryPath: string;
  skillFilePath: string;
  metadataSha256: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string | null;
}

export interface InvalidSkillEntry {
  sourceId: string;
  sourceKind: SkillSourceKind;
  skillDirectoryPath: string;
  skillFilePath: string | null;
  errorCode: string;
  message: string;
}

export interface SkillsListRequest {
  workspaceId: WorkspaceId;
}

export interface SkillsListResult {
  workspaceId: WorkspaceId;
  skills: SkillSummary[];
  shadowed: SkillSummary[];
  invalid: InvalidSkillEntry[];
}

export interface SkillsReadRequest {
  workspaceId: WorkspaceId;
  skillId: string;
}

export interface SkillsReadResult {
  workspaceId: WorkspaceId;
  skill: SkillSummary;
  content: string;
  sha256: string;
}

export interface InstructionsServiceOptions {
  resolveWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceRecord | undefined>;
  providers?: InstructionProvider[];
  readFile?(path: string): Promise<Buffer>;
  homeDirectory?: string;
}

interface CachedInstructionFile {
  realPath: string;
  fingerprint: string;
  content: string;
  sha256: string;
}

interface FileMetadata {
  realPath: string;
  fingerprint: string;
  size: number;
}

export class InstructionsError extends Error {
  readonly code: string;
  readonly path: string | null;

  constructor(code: string, path: string | null, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstructionsError';
    this.code = code;
    this.path = path;
  }
}

export class InstructionsService {
  readonly #resolveWorkspace: InstructionsServiceOptions['resolveWorkspace'];
  readonly #readFile: NonNullable<InstructionsServiceOptions['readFile']>;
  readonly #providers: InstructionProvider[];
  readonly #homeDirectory: string;
  readonly #fileCache = new Map<string, CachedInstructionFile>();

  constructor(options: InstructionsServiceOptions) {
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#readFile = options.readFile ?? readFileFromDisk;
    this.#homeDirectory = resolve(options.homeDirectory ?? homedir());

    const builtins: InstructionProvider[] = [
      this.#fileProvider('builtin.claude', 100, 'CLAUDE.md'),
      this.#fileProvider('builtin.agents', 200, 'AGENTS.md'),
    ];
    const providers = [...builtins, ...(options.providers ?? [])];
    validateProviders(providers);
    this.#providers = providers.sort(compareProviders);
  }

  async resolve(request: InstructionsResolveRequest): Promise<InstructionsResolveResult> {
    const workspace = await this.#resolveWorkspace(request.workspaceId);
    if (workspace === undefined) {
      throw new InstructionsError(
        'WORKSPACE_NOT_FOUND',
        null,
        `workspace ${request.workspaceId} was not found`,
      );
    }
    if (workspace.status !== 'available') {
      throw new InstructionsError(
        'WORKSPACE_UNAVAILABLE',
        workspace.canonicalPath,
        `workspace ${request.workspaceId} is ${workspace.status}`,
      );
    }

    const scopePath = normalizeRelativePath(request.scopePath ?? '.');
    const workspaceRoot = await canonicalWorkspaceRoot(workspace);
    const scopes = buildScopeChain(scopePath);
    const documents: InstructionDocument[] = [];
    let totalBytes = 0;

    for (const scope of scopes) {
      const absoluteScopePath = await resolveScopeDirectory(workspaceRoot, scope);
      const context: InstructionProviderContext = {
        workspace,
        workspaceRoot,
        scopePath: scope,
        absoluteScopePath,
      };

      for (const provider of this.#providers) {
        let contributions: InstructionProviderContribution[];
        try {
          contributions = await provider.resolveScope(context);
        } catch (error) {
          if (error instanceof InstructionsError) throw error;
          throw new InstructionsError(
            'INSTRUCTION_PROVIDER_FAILED',
            scope,
            `instruction provider ${provider.id} failed at scope ${scope}`,
            { cause: error },
          );
        }

        const normalized = contributions.map((contribution) =>
          normalizeContribution(provider.id, scope, contribution),
        );
        normalized.sort(compareDocumentsWithinProvider);
        for (const document of normalized) {
          totalBytes += Buffer.byteLength(document.content, 'utf8');
          if (totalBytes > MAX_TOTAL_INSTRUCTION_BYTES) {
            throw new InstructionsError(
              'INSTRUCTIONS_TOO_LARGE',
              scopePath,
              `resolved instructions exceed ${MAX_TOTAL_INSTRUCTION_BYTES} UTF-8 bytes`,
            );
          }
          documents.push(document);
        }
      }
    }

    return {
      workspaceId: request.workspaceId,
      scopePath,
      scopes,
      documents,
    };
  }

  async listSkills(request: SkillsListRequest): Promise<SkillsListResult> {
    const workspace = await this.#requireWorkspace(request.workspaceId);
    const workspaceRoot = await canonicalWorkspaceRoot(workspace);
    const discovered = await this.#discoverSkills(workspaceRoot);
    const skills: SkillSummary[] = [];
    const shadowed: SkillSummary[] = [];
    const selectedNames = new Set<string>();
    for (const candidate of discovered.skills) {
      if (selectedNames.has(candidate.summary.name)) {
        shadowed.push(candidate.summary);
        continue;
      }
      selectedNames.add(candidate.summary.name);
      skills.push(candidate.summary);
    }
    return {
      workspaceId: request.workspaceId,
      skills,
      shadowed,
      invalid: discovered.invalid,
    };
  }

  async readSkill(request: SkillsReadRequest): Promise<SkillsReadResult> {
    if (
      typeof request.skillId !== 'string' ||
      request.skillId.length === 0 ||
      request.skillId.includes('\0')
    ) {
      throw new InstructionsError(
        'INVALID_SKILL_ID',
        null,
        'skillId must be a non-empty NUL-free string',
      );
    }
    const workspace = await this.#requireWorkspace(request.workspaceId);
    const workspaceRoot = await canonicalWorkspaceRoot(workspace);
    const discovered = await this.#discoverSkills(workspaceRoot);
    const candidate = discovered.skills.find((entry) => entry.summary.skillId === request.skillId);
    if (candidate === undefined) {
      throw new InstructionsError(
        'SKILL_NOT_FOUND',
        request.skillId,
        `skill ${request.skillId} was not found`,
      );
    }

    let buffer: Buffer;
    try {
      buffer = await this.#readFile(candidate.skillFilePath);
    } catch (error) {
      throw new InstructionsError(
        'SKILL_INACCESSIBLE',
        candidate.summary.skillFilePath,
        `skill ${request.skillId} is inaccessible`,
        { cause: error },
      );
    }
    if (buffer.byteLength > MAX_INSTRUCTION_BYTES) {
      throw new InstructionsError(
        'SKILL_TOO_LARGE',
        candidate.summary.skillFilePath,
        `skill file exceeds ${MAX_INSTRUCTION_BYTES} bytes`,
      );
    }
    const content = decodeInstructionText(buffer, candidate.summary.skillFilePath);
    return {
      workspaceId: request.workspaceId,
      skill: candidate.summary,
      content,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  }

  async #discoverSkills(workspaceRoot: string): Promise<SkillDiscoveryResult> {
    const batches = await Promise.all([
      discoverSkillRoot({
        sourceId: 'project',
        sourceKind: 'project',
        precedence: 0,
        rootCandidate: join(workspaceRoot, '.agents', 'skills'),
        boundaryRoot: workspaceRoot,
        displayBase: workspaceRoot,
      }),
      discoverSkillRoot({
        sourceId: 'benchhand-user',
        sourceKind: 'benchhand-user',
        precedence: 100,
        rootCandidate: join(this.#homeDirectory, '.benchhand', 'skills'),
      }),
      discoverSkillRoot({
        sourceId: 'agents-user',
        sourceKind: 'agents-user',
        precedence: 200,
        rootCandidate: join(this.#homeDirectory, '.agents', 'skills'),
      }),
      discoverSkillRoot({
        sourceId: 'codex-user',
        sourceKind: 'codex-user',
        precedence: 300,
        rootCandidate: join(this.#homeDirectory, '.codex', 'skills'),
      }),
      discoverSkillRoot({
        sourceId: 'devspace-compat',
        sourceKind: 'devspace-compat',
        precedence: 400,
        rootCandidate: join(this.#homeDirectory, '.devspace', 'skills'),
      }),
    ]);
    const skills = batches.flatMap((batch) => batch.skills);
    skills.sort(compareDiscoveredSkills);
    return {
      skills,
      invalid: batches.flatMap((batch) => batch.invalid),
    };
  }

  #fileProvider(id: string, precedence: number, filename: string): InstructionProvider {
    return {
      id,
      precedence,
      resolveScope: async (context) => {
        const document = await this.#readInstructionFile(context, filename);
        return document === undefined
          ? []
          : [
              {
                sourceId: filename,
                content: document.content,
                path: portableJoin(context.scopePath, filename),
              },
            ];
      },
    };
  }

  async #readInstructionFile(
    context: InstructionProviderContext,
    filename: string,
  ): Promise<CachedInstructionFile | undefined> {
    const candidate = join(context.absoluteScopePath, filename);
    let metadata: FileMetadata | undefined;
    try {
      metadata = await instructionFileMetadata(context.workspaceRoot, candidate, filename);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        this.#fileCache.delete(candidate);
        return undefined;
      }
      throw error;
    }

    const cached = this.#fileCache.get(candidate);

    for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
      if (metadata.size > MAX_INSTRUCTION_BYTES) {
        throw new InstructionsError(
          'INSTRUCTION_TOO_LARGE',
          filename,
          `instruction file exceeds ${MAX_INSTRUCTION_BYTES} bytes: ${filename}`,
        );
      }

      let buffer: Buffer;
      try {
        buffer = await this.#readFile(metadata.realPath);
      } catch (error) {
        throw mapReadError(filename, error);
      }
      if (buffer.byteLength > MAX_INSTRUCTION_BYTES) {
        throw new InstructionsError(
          'INSTRUCTION_TOO_LARGE',
          filename,
          `instruction file exceeds ${MAX_INSTRUCTION_BYTES} bytes: ${filename}`,
        );
      }
      const after = await instructionFileMetadata(context.workspaceRoot, candidate, filename).catch(
        (error) => {
          throw mapReadError(filename, error);
        },
      );

      if (
        after.realPath === metadata.realPath &&
        after.fingerprint === metadata.fingerprint &&
        after.size === buffer.byteLength
      ) {
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const content =
          cached?.sha256 === sha256 ? cached.content : decodeInstructionText(buffer, filename);
        const stable: CachedInstructionFile = {
          realPath: metadata.realPath,
          fingerprint: metadata.fingerprint,
          content,
          sha256,
        };
        this.#fileCache.set(candidate, stable);
        return stable;
      }
      metadata = after;
    }

    throw new InstructionsError(
      'INSTRUCTION_CHANGED_DURING_READ',
      filename,
      `instruction file changed repeatedly while being read: ${filename}`,
    );
  }

  async #requireWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceRecord> {
    const workspace = await this.#resolveWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new InstructionsError(
        'WORKSPACE_NOT_FOUND',
        null,
        `workspace ${workspaceId} was not found`,
      );
    }
    if (workspace.status !== 'available') {
      throw new InstructionsError(
        'WORKSPACE_UNAVAILABLE',
        workspace.canonicalPath,
        `workspace ${workspaceId} is ${workspace.status}`,
      );
    }
    return workspace;
  }
}

interface SkillRootDescriptor {
  sourceId: string;
  sourceKind: SkillSourceKind;
  precedence: number;
  rootCandidate: string;
  boundaryRoot?: string;
  displayBase?: string;
}

interface DiscoveredSkill {
  precedence: number;
  summary: SkillSummary;
  skillFilePath: string;
}

interface SkillDiscoveryResult {
  skills: DiscoveredSkill[];
  invalid: InvalidSkillEntry[];
}

async function discoverSkillRoot(descriptor: SkillRootDescriptor): Promise<SkillDiscoveryResult> {
  let root: string;
  try {
    root = await realpath(descriptor.rootCandidate);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return { skills: [], invalid: [] };
    throw new InstructionsError(
      'SKILL_ROOT_INACCESSIBLE',
      descriptor.rootCandidate,
      `skill root ${descriptor.sourceId} is inaccessible`,
      { cause: error },
    );
  }
  if (descriptor.boundaryRoot !== undefined && !isSameOrDescendant(descriptor.boundaryRoot, root)) {
    throw new InstructionsError(
      'SKILL_ROOT_OUTSIDE_WORKSPACE',
      descriptor.rootCandidate,
      `skill root ${descriptor.sourceId} resolves outside its allowed boundary`,
    );
  }

  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  const skills: DiscoveredSkill[] = [];
  const invalid: InvalidSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDirectory = await realpath(join(root, entry.name)).catch(() => null);
    if (skillDirectory === null || !isSameOrDescendant(root, skillDirectory)) continue;
    const skillFile = join(skillDirectory, 'SKILL.md');
    let canonicalSkillFile: string;
    try {
      canonicalSkillFile = await realpath(skillFile);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) continue;
      invalid.push({
        sourceId: descriptor.sourceId,
        sourceKind: descriptor.sourceKind,
        skillDirectoryPath: displaySkillPath(descriptor.displayBase, skillDirectory),
        skillFilePath: displaySkillPath(descriptor.displayBase, skillFile),
        errorCode: 'SKILL_FILE_INACCESSIBLE',
        message: `SKILL.md is inaccessible: ${displaySkillPath(descriptor.displayBase, skillFile)}`,
      });
      continue;
    }
    if (!isSameOrDescendant(root, canonicalSkillFile)) {
      const displayedSkillFile = displaySkillPath(descriptor.displayBase, skillFile);
      invalid.push({
        sourceId: descriptor.sourceId,
        sourceKind: descriptor.sourceKind,
        skillDirectoryPath: displaySkillPath(descriptor.displayBase, skillDirectory),
        skillFilePath: displayedSkillFile,
        errorCode: 'SKILL_FILE_OUTSIDE_ROOT',
        message: `SKILL.md resolves outside skill root: ${displayedSkillFile}`,
      });
      continue;
    }
    let metadata: ParsedSkillMetadata;
    try {
      metadata = await readSkillMetadata(canonicalSkillFile, entry.name);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) continue;
      if (error instanceof InstructionsError) {
        invalid.push({
          sourceId: descriptor.sourceId,
          sourceKind: descriptor.sourceKind,
          skillDirectoryPath: displaySkillPath(descriptor.displayBase, skillDirectory),
          skillFilePath: displaySkillPath(descriptor.displayBase, skillFile),
          errorCode: error.code,
          message: error.message,
        });
        continue;
      }
      throw error;
    }
    skills.push({
      precedence: descriptor.precedence,
      skillFilePath: canonicalSkillFile,
      summary: {
        skillId: `${descriptor.sourceId}:${metadata.name}`,
        name: metadata.name,
        description: metadata.description,
        sourceId: descriptor.sourceId,
        sourceKind: descriptor.sourceKind,
        skillDirectoryPath: displaySkillPath(descriptor.displayBase, skillDirectory),
        skillFilePath: displaySkillPath(descriptor.displayBase, skillFile),
        metadataSha256: metadata.metadataSha256,
        license: metadata.license,
        compatibility: metadata.compatibility,
        metadata: metadata.metadata,
        allowedTools: metadata.allowedTools,
      },
    });
  }
  return { skills, invalid };
}

function compareDiscoveredSkills(left: DiscoveredSkill, right: DiscoveredSkill): number {
  return (
    left.precedence - right.precedence ||
    compareCodePoints(left.summary.name, right.summary.name) ||
    compareCodePoints(left.summary.sourceId, right.summary.sourceId)
  );
}

interface ParsedSkillMetadata {
  name: string;
  description: string;
  metadataSha256: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string | null;
}

async function readSkillMetadata(
  skillFile: string,
  parentDirectoryName: string,
): Promise<ParsedSkillMetadata> {
  const handle = await open(skillFile, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SKILL_FRONTMATTER_BYTES + 1);
    const { bytesRead } = await handle.read({
      buffer,
      offset: 0,
      length: buffer.byteLength,
      position: 0,
    });
    const source = decodeInstructionText(buffer.subarray(0, bytesRead), skillFile);
    const frontmatter = extractSkillFrontmatter(source, skillFile);
    const document = parseDocument(frontmatter, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new InstructionsError(
        'INVALID_SKILL_FRONTMATTER',
        skillFile,
        `invalid SKILL.md YAML frontmatter: ${document.errors[0]?.message ?? 'unknown YAML error'}`,
      );
    }
    const value = document.toJS({ maxAliasCount: 0 }) as unknown;
    return validateSkillMetadata(value, parentDirectoryName, frontmatter, skillFile);
  } finally {
    await handle.close();
  }
}

function extractSkillFrontmatter(source: string, path: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) {
    throw new InstructionsError(
      'INVALID_SKILL_FRONTMATTER',
      path,
      'SKILL.md must start with YAML frontmatter',
    );
  }
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing < 0) {
    throw new InstructionsError(
      'SKILL_FRONTMATTER_TOO_LARGE',
      path,
      `SKILL.md frontmatter must close within ${MAX_SKILL_FRONTMATTER_BYTES} bytes`,
    );
  }
  return normalized.slice(4, closing);
}

function validateSkillMetadata(
  value: unknown,
  parentDirectoryName: string,
  rawFrontmatter: string,
  path: string,
): ParsedSkillMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InstructionsError(
      'INVALID_SKILL_METADATA',
      path,
      'SKILL.md frontmatter must be a map',
    );
  }
  const data = value as Record<string, unknown>;
  const name = readSkillString(data.name, 'name', 1, 64, path);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name !== parentDirectoryName) {
    throw new InstructionsError(
      'INVALID_SKILL_NAME',
      path,
      'skill name must use lowercase letters, numbers, single hyphens, and match its parent directory',
    );
  }
  const description = readSkillString(data.description, 'description', 1, 1024, path);
  const license = optionalSkillString(data.license, 'license', 1, 1024, path);
  const compatibility = optionalSkillString(data.compatibility, 'compatibility', 1, 500, path);
  const allowedTools = optionalSkillString(data['allowed-tools'], 'allowed-tools', 1, 4096, path);
  const metadata = readSkillMetadataMap(data.metadata, path);
  return {
    name,
    description,
    metadataSha256: createHash('sha256').update(rawFrontmatter, 'utf8').digest('hex'),
    license,
    compatibility,
    metadata,
    allowedTools,
  };
}

function readSkillString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  path: string,
): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new InstructionsError(
      'INVALID_SKILL_METADATA',
      path,
      `skill ${field} must be a string between ${minimum} and ${maximum} characters`,
    );
  }
  return value;
}

function optionalSkillString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  path: string,
): string | null {
  if (value === undefined) return null;
  return readSkillString(value, field, minimum, maximum, path);
}

function readSkillMetadataMap(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InstructionsError(
      'INVALID_SKILL_METADATA',
      path,
      'skill metadata must be a map of string keys to string values',
    );
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new InstructionsError(
        'INVALID_SKILL_METADATA',
        path,
        'skill metadata values must be strings',
      );
    }
    result[key] = item;
  }
  return result;
}

function toPortableRelative(root: string, candidate: string): string {
  const value = relative(root, candidate);
  return value === '' ? '.' : value.split(sep).join('/');
}

function displaySkillPath(base: string | undefined, candidate: string): string {
  if (base === undefined) return candidate;
  return toPortableRelative(base, candidate);
}

function validateProviders(providers: InstructionProvider[]): void {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (
      typeof provider.id !== 'string' ||
      provider.id.length === 0 ||
      provider.id.includes('\0') ||
      !Number.isSafeInteger(provider.precedence)
    ) {
      throw new TypeError('instruction providers require a non-empty id and integer precedence');
    }
    if (ids.has(provider.id)) {
      throw new TypeError(`duplicate instruction provider id: ${provider.id}`);
    }
    ids.add(provider.id);
  }
}

function compareProviders(left: InstructionProvider, right: InstructionProvider): number {
  return left.precedence - right.precedence || compareCodePoints(left.id, right.id);
}

function normalizeContribution(
  providerId: string,
  scopePath: string,
  contribution: InstructionProviderContribution,
): InstructionDocument {
  if (
    typeof contribution.sourceId !== 'string' ||
    contribution.sourceId.length === 0 ||
    contribution.sourceId.includes('\0')
  ) {
    throw new InstructionsError(
      'INVALID_PROVIDER_OUTPUT',
      scopePath,
      `instruction provider ${providerId} returned an invalid sourceId`,
    );
  }
  if (typeof contribution.content !== 'string' || contribution.content.includes('\0')) {
    throw new InstructionsError(
      'INVALID_PROVIDER_OUTPUT',
      scopePath,
      `instruction provider ${providerId} returned invalid text content`,
    );
  }
  if (Buffer.byteLength(contribution.content, 'utf8') > MAX_INSTRUCTION_BYTES) {
    throw new InstructionsError(
      'INSTRUCTION_TOO_LARGE',
      scopePath,
      `instruction contribution exceeds ${MAX_INSTRUCTION_BYTES} UTF-8 bytes`,
    );
  }
  const path = contribution.path ?? null;
  if (path !== null && (typeof path !== 'string' || path.length === 0 || path.includes('\0'))) {
    throw new InstructionsError(
      'INVALID_PROVIDER_OUTPUT',
      scopePath,
      `instruction provider ${providerId} returned an invalid path`,
    );
  }
  return {
    providerId,
    scopePath,
    sourceId: contribution.sourceId,
    path,
    content: contribution.content,
    sha256: createHash('sha256').update(contribution.content, 'utf8').digest('hex'),
  };
}

function compareDocumentsWithinProvider(
  left: InstructionDocument,
  right: InstructionDocument,
): number {
  return (
    compareCodePoints(left.sourceId, right.sourceId) ||
    compareCodePoints(left.path ?? '', right.path ?? '') ||
    compareCodePoints(left.sha256, right.sha256)
  );
}

function normalizeRelativePath(input: string): string {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw new InstructionsError('INVALID_PATH', null, 'scopePath must be a NUL-free string');
  }
  if (posix.isAbsolute(input) || win32.isAbsolute(input) || isAbsolute(input)) {
    throw new InstructionsError(
      'PATH_OUTSIDE_WORKSPACE',
      input,
      'absolute scope paths are not allowed',
    );
  }
  const portable = input.replaceAll('\\', '/');
  const segments = portable.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new InstructionsError(
      'PATH_OUTSIDE_WORKSPACE',
      input,
      'scope path traversal is not allowed',
    );
  }
  if (segments.length > MAX_SCOPE_DEPTH) {
    throw new InstructionsError(
      'SCOPE_TOO_DEEP',
      input,
      `instruction scope exceeds ${MAX_SCOPE_DEPTH} directory levels`,
    );
  }
  return segments.length === 0 ? '.' : segments.join('/');
}

function buildScopeChain(scopePath: string): string[] {
  if (scopePath === '.') return ['.'];
  const scopes = ['.'];
  const segments = scopePath.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    scopes.push(segments.slice(0, index).join('/'));
  }
  return scopes;
}

async function canonicalWorkspaceRoot(workspace: WorkspaceRecord): Promise<string> {
  let root: string;
  try {
    root = await realpath(workspace.canonicalPath);
  } catch (error) {
    throw new InstructionsError(
      'WORKSPACE_UNAVAILABLE',
      workspace.canonicalPath,
      `workspace path is unavailable: ${workspace.canonicalPath}`,
      { cause: error },
    );
  }
  return root;
}

async function resolveScopeDirectory(root: string, portablePath: string): Promise<string> {
  const candidate =
    portablePath === '.' ? root : resolve(root, ...portablePath.split('/').filter(Boolean));
  if (!isSameOrDescendant(root, candidate)) {
    throw new InstructionsError(
      'PATH_OUTSIDE_WORKSPACE',
      portablePath,
      `scope escapes workspace: ${portablePath}`,
    );
  }

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      throw new InstructionsError(
        'SCOPE_NOT_FOUND',
        portablePath,
        `instruction scope does not exist: ${portablePath}`,
        { cause: error },
      );
    }
    throw new InstructionsError(
      'SCOPE_INACCESSIBLE',
      portablePath,
      `instruction scope is inaccessible: ${portablePath}`,
      { cause: error },
    );
  }
  if (!isSameOrDescendant(root, canonical)) {
    throw new InstructionsError(
      'PATH_OUTSIDE_WORKSPACE',
      portablePath,
      `scope resolves outside workspace: ${portablePath}`,
    );
  }

  const stats = await stat(canonical).catch((error) => {
    throw new InstructionsError(
      'SCOPE_INACCESSIBLE',
      portablePath,
      `instruction scope is inaccessible: ${portablePath}`,
      { cause: error },
    );
  });
  if (!stats.isDirectory()) {
    throw new InstructionsError(
      'SCOPE_NOT_DIRECTORY',
      portablePath,
      `instruction scope is not a directory: ${portablePath}`,
    );
  }
  return canonical;
}

async function instructionFileMetadata(
  root: string,
  candidate: string,
  portablePath: string,
): Promise<FileMetadata> {
  await lstat(candidate);
  const realPath = await realpath(candidate);
  if (!isSameOrDescendant(root, realPath)) {
    throw new InstructionsError(
      'INSTRUCTION_PATH_OUTSIDE_WORKSPACE',
      portablePath,
      `instruction file resolves outside workspace: ${portablePath}`,
    );
  }
  const stats = await stat(realPath, { bigint: true });
  if (!stats.isFile()) {
    throw new InstructionsError(
      'INSTRUCTION_SOURCE_NOT_FILE',
      portablePath,
      `instruction source is not a regular file: ${portablePath}`,
    );
  }
  if (stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InstructionsError(
      'INSTRUCTION_TOO_LARGE',
      portablePath,
      `instruction file size exceeds safe integer range: ${portablePath}`,
    );
  }
  const size = Number(stats.size);
  return {
    realPath,
    size,
    fingerprint: [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':'),
  };
}

function decodeInstructionText(buffer: Buffer, path: string): string {
  if (buffer.includes(0)) {
    throw new InstructionsError(
      'INSTRUCTION_BINARY_UNSUPPORTED',
      path,
      `instruction file contains binary content: ${path}`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new InstructionsError(
      'INSTRUCTION_BINARY_UNSUPPORTED',
      path,
      `instruction file is not valid UTF-8 text: ${path}`,
      { cause: error },
    );
  }
}

function mapReadError(path: string, error: unknown): InstructionsError {
  if (error instanceof InstructionsError) return error;
  if (isErrnoCode(error, 'ENOENT')) {
    return new InstructionsError(
      'INSTRUCTION_CHANGED_DURING_READ',
      path,
      `instruction file disappeared while being read: ${path}`,
      { cause: error },
    );
  }
  return new InstructionsError(
    'INSTRUCTION_INACCESSIBLE',
    path,
    `instruction file is inaccessible: ${path}`,
    { cause: error },
  );
}

function portableJoin(scopePath: string, filename: string): string {
  return scopePath === '.' ? filename : `${scopePath}/${filename}`;
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function isErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
