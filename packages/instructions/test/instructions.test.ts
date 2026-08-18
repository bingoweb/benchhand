import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseEntityId, parseEntityVersion, type WorkspaceRecord } from '@benchhand/contracts';

import { type InstructionProvider, InstructionsError, InstructionsService } from '../src/index.js';

const workspaceId = parseEntityId('workspace', 'ws_instructions_fixture');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function workspaceRecord(root: string, status: WorkspaceRecord['status'] = 'available') {
  const canonicalPath = await realpath(root);
  return {
    workspaceId,
    canonicalPath,
    requestedPath: canonicalPath,
    mode: 'checkout' as const,
    repoRoot: canonicalPath,
    worktreePath: null,
    baseRef: null,
    branch: null,
    createdAt: '2026-08-18T00:00:00.000Z',
    lastUsedAt: '2026-08-18T00:00:00.000Z',
    ownerInstance: 'daemon_fixture',
    status,
    metadataVersion: parseEntityVersion(1),
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

test('resolves CLAUDE.md and AGENTS.md from broad scope to nearest scope deterministically', async () => {
  const dir = tempDir('benchhand-instructions-hierarchy-');
  mkdirSync(join(dir, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), 'root claude\n');
  writeFileSync(join(dir, 'AGENTS.md'), 'root agents\n');
  writeFileSync(join(dir, 'packages', 'AGENTS.md'), 'packages agents\n');
  writeFileSync(join(dir, 'packages', 'app', 'CLAUDE.md'), 'app claude\n');

  try {
    const workspace = await workspaceRecord(dir);
    const service = new InstructionsService({ resolveWorkspace: async () => workspace });
    const result = await service.resolve({ workspaceId, scopePath: 'packages/app/src' });

    assert.deepEqual(result.scopes, ['.', 'packages', 'packages/app', 'packages/app/src']);
    assert.deepEqual(
      result.documents.map((document) => ({
        providerId: document.providerId,
        scopePath: document.scopePath,
        sourceId: document.sourceId,
        path: document.path,
        content: document.content,
      })),
      [
        {
          providerId: 'builtin.claude',
          scopePath: '.',
          sourceId: 'CLAUDE.md',
          path: 'CLAUDE.md',
          content: 'root claude\n',
        },
        {
          providerId: 'builtin.agents',
          scopePath: '.',
          sourceId: 'AGENTS.md',
          path: 'AGENTS.md',
          content: 'root agents\n',
        },
        {
          providerId: 'builtin.agents',
          scopePath: 'packages',
          sourceId: 'AGENTS.md',
          path: 'packages/AGENTS.md',
          content: 'packages agents\n',
        },
        {
          providerId: 'builtin.claude',
          scopePath: 'packages/app',
          sourceId: 'CLAUDE.md',
          path: 'packages/app/CLAUDE.md',
          content: 'app claude\n',
        },
      ],
    );
    assert.deepEqual(
      result.documents.map((document) => document.sha256),
      [
        sha256('root claude\n'),
        sha256('root agents\n'),
        sha256('packages agents\n'),
        sha256('app claude\n'),
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates cached instruction bytes and invalidates on same-size change deletion and recreation', async () => {
  const dir = tempDir('benchhand-instructions-cache-');
  const path = join(dir, 'AGENTS.md');
  writeFileSync(path, 'first\n');
  let reads = 0;

  try {
    const workspace = await workspaceRecord(dir);
    const service = new InstructionsService({
      resolveWorkspace: async () => workspace,
      readFile: async (candidate) => {
        reads += 1;
        return readFile(candidate);
      },
    });

    const first = await service.resolve({ workspaceId });
    const second = await service.resolve({ workspaceId });
    assert.equal(first.documents[0]?.content, 'first\n');
    assert.equal(second.documents[0]?.content, 'first\n');
    assert.equal(reads, 2);

    writeFileSync(path, 'other\n');
    const changed = await service.resolve({ workspaceId });
    assert.equal(changed.documents[0]?.content, 'other\n');
    assert.equal(reads, 3);

    unlinkSync(path);
    const deleted = await service.resolve({ workspaceId });
    assert.deepEqual(deleted.documents, []);
    assert.equal(reads, 3);

    writeFileSync(path, 'again\n');
    const recreated = await service.resolve({ workspaceId });
    assert.equal(recreated.documents[0]?.content, 'again\n');
    assert.equal(reads, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not trust unchanged filesystem metadata when instruction bytes change', async () => {
  const dir = tempDir('benchhand-instructions-coarse-metadata-');
  const path = join(dir, 'AGENTS.md');
  writeFileSync(path, 'first\n');
  const snapshots = [Buffer.from('first\n'), Buffer.from('other\n')];
  let reads = 0;

  try {
    const workspace = await workspaceRecord(dir);
    const service = new InstructionsService({
      resolveWorkspace: async () => workspace,
      readFile: async () => snapshots[Math.min(reads++, snapshots.length - 1)] ?? Buffer.alloc(0),
    });

    const first = await service.resolve({ workspaceId });
    const changedWithoutMetadataSignal = await service.resolve({ workspaceId });
    assert.equal(first.documents[0]?.content, 'first\n');
    assert.equal(changedWithoutMetadataSignal.documents[0]?.content, 'other\n');
    assert.equal(reads, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orders future instruction providers deterministically inside each scope', async () => {
  const dir = tempDir('benchhand-instructions-provider-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'CLAUDE.md'), 'claude\n');
  writeFileSync(join(dir, 'AGENTS.md'), 'agents\n');

  const provider: InstructionProvider = {
    id: 'plugin.team-policy',
    precedence: 150,
    async resolveScope(context) {
      if (context.scopePath !== '.') return [];
      return [{ sourceId: 'team', content: 'team policy\n' }];
    },
  };

  try {
    const workspace = await workspaceRecord(dir);
    const service = new InstructionsService({
      resolveWorkspace: async () => workspace,
      providers: [provider],
    });
    const result = await service.resolve({ workspaceId, scopePath: 'src' });
    assert.deepEqual(
      result.documents.map((document) => document.providerId),
      ['builtin.claude', 'plugin.team-policy', 'builtin.agents'],
    );
    assert.equal(result.documents[1]?.path, null);
    assert.equal(result.documents[1]?.sha256, sha256('team policy\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed for traversal unavailable workspaces and instruction symlink escape', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = tempDir('benchhand-instructions-boundary-');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'AGENTS.md'), 'outside\n');
  symlinkSync(join(outside, 'AGENTS.md'), join(root, 'AGENTS.md'));

  try {
    const available = await workspaceRecord(root);
    const service = new InstructionsService({ resolveWorkspace: async () => available });
    await assert.rejects(
      () => service.resolve({ workspaceId, scopePath: '../outside' }),
      (error: unknown) =>
        error instanceof InstructionsError && error.code === 'PATH_OUTSIDE_WORKSPACE',
    );
    await assert.rejects(
      () => service.resolve({ workspaceId }),
      (error: unknown) =>
        error instanceof InstructionsError && error.code === 'INSTRUCTION_PATH_OUTSIDE_WORKSPACE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed for missing and unavailable durable workspace handles on every platform', async () => {
  const dir = tempDir('benchhand-instructions-workspace-state-');
  try {
    const missingService = new InstructionsService({ resolveWorkspace: async () => undefined });
    await assert.rejects(
      () => missingService.resolve({ workspaceId }),
      (error: unknown) =>
        error instanceof InstructionsError && error.code === 'WORKSPACE_NOT_FOUND',
    );

    const unavailable = await workspaceRecord(dir, 'missing');
    const unavailableService = new InstructionsService({
      resolveWorkspace: async () => unavailable,
    });
    await assert.rejects(
      () => unavailableService.resolve({ workspaceId }),
      (error: unknown) =>
        error instanceof InstructionsError && error.code === 'WORKSPACE_UNAVAILABLE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects binary and oversized built-in instruction files instead of returning lossy context', async () => {
  const dir = tempDir('benchhand-instructions-content-bounds-');
  const path = join(dir, 'AGENTS.md');
  try {
    const workspace = await workspaceRecord(dir);
    const service = new InstructionsService({ resolveWorkspace: async () => workspace });

    writeFileSync(path, Buffer.from([0x61, 0x00, 0x62]));
    await assert.rejects(
      () => service.resolve({ workspaceId }),
      (error: unknown) =>
        error instanceof InstructionsError && error.code === 'INSTRUCTION_BINARY_UNSUPPORTED',
    );

    writeFileSync(path, Buffer.alloc(256 * 1024 + 1, 0x61));
    await assert.rejects(
      () => service.resolve({ workspaceId }),
      (error: unknown) =>
        error instanceof InstructionsError && error.code === 'INSTRUCTION_TOO_LARGE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovers project Agent Skills metadata without returning the SKILL.md body', async () => {
  const dir = tempDir('benchhand-skills-project-');
  const skillDir = join(dir, '.agents', 'skills', 'pdf-processing');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: pdf-processing',
      'description: >-',
      '  Extract and inspect PDF documents.',
      '  Use when a task involves PDF files.',
      'license: Apache-2.0',
      'compatibility: Requires a PDF-capable runtime.',
      'metadata:',
      '  author: benchhand-test',
      '  version: "1.0"',
      'allowed-tools: Read Bash(pdftotext:*)',
      '---',
      '',
      '# Full instructions',
      '',
      'This body must not be returned by metadata discovery.',
      '',
    ].join('\n'),
  );

  try {
    const workspace = await workspaceRecord(dir);
    const service = new InstructionsService({ resolveWorkspace: async () => workspace });
    const skillsApi = service as InstructionsService & {
      listSkills?: (request: { workspaceId: typeof workspaceId }) => Promise<unknown>;
    };
    assert.equal(typeof skillsApi.listSkills, 'function', 'expected listSkills API to exist');
    const result = await skillsApi.listSkills?.({ workspaceId });
    assert.deepEqual(result, {
      workspaceId,
      skills: [
        {
          skillId: 'project:pdf-processing',
          name: 'pdf-processing',
          description: 'Extract and inspect PDF documents. Use when a task involves PDF files.',
          sourceId: 'project',
          sourceKind: 'project',
          skillDirectoryPath: '.agents/skills/pdf-processing',
          skillFilePath: '.agents/skills/pdf-processing/SKILL.md',
          metadataSha256: sha256(
            [
              'name: pdf-processing',
              'description: >-',
              '  Extract and inspect PDF documents.',
              '  Use when a task involves PDF files.',
              'license: Apache-2.0',
              'compatibility: Requires a PDF-capable runtime.',
              'metadata:',
              '  author: benchhand-test',
              '  version: "1.0"',
              'allowed-tools: Read Bash(pdftotext:*)',
            ].join('\n'),
          ),
          license: 'Apache-2.0',
          compatibility: 'Requires a PDF-capable runtime.',
          metadata: { author: 'benchhand-test', version: '1.0' },
          allowedTools: 'Read Bash(pdftotext:*)',
        },
      ],
      shadowed: [],
      invalid: [],
    });
    assert.equal(JSON.stringify(result).includes('Full instructions'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefers a project skill over user skill roots with the same name and reports the shadowed source', async () => {
  const dir = tempDir('benchhand-skills-precedence-');
  const project = join(dir, 'project');
  const home = join(dir, 'home');
  const projectSkill = join(project, '.agents', 'skills', 'code-review');
  const benchhandSkill = join(home, '.benchhand', 'skills', 'code-review');
  mkdirSync(projectSkill, { recursive: true });
  mkdirSync(benchhandSkill, { recursive: true });
  writeFileSync(
    join(projectSkill, 'SKILL.md'),
    '---\nname: code-review\ndescription: Project review rules.\n---\n\nProject body.\n',
  );
  writeFileSync(
    join(benchhandSkill, 'SKILL.md'),
    '---\nname: code-review\ndescription: User review defaults.\n---\n\nUser body.\n',
  );

  try {
    const workspace = await workspaceRecord(project);
    const service = new InstructionsService({
      resolveWorkspace: async () => workspace,
      homeDirectory: home,
    } as ConstructorParameters<typeof InstructionsService>[0] & { homeDirectory: string });
    const result = await service.listSkills({ workspaceId });
    assert.deepEqual(
      result.skills.map((skill) => ({ skillId: skill.skillId, description: skill.description })),
      [{ skillId: 'project:code-review', description: 'Project review rules.' }],
    );
    assert.deepEqual(
      result.shadowed.map((skill) => ({ skillId: skill.skillId, description: skill.description })),
      [{ skillId: 'benchhand-user:code-review', description: 'User review defaults.' }],
    );
    assert.deepEqual(result.invalid, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovers Benchhand standard and compatibility user skill roots in deterministic precedence order', async () => {
  const dir = tempDir('benchhand-skills-user-roots-');
  const project = join(dir, 'project');
  const home = join(dir, 'home');
  mkdirSync(project);
  const fixtures = [
    ['.benchhand/skills/benchhand-default', 'benchhand-default', 'Benchhand user skill.'],
    ['.agents/skills/open-standard', 'open-standard', 'Open Agent Skills user skill.'],
    ['.codex/skills/codex-compat', 'codex-compat', 'Codex compatibility skill.'],
    ['.devspace/skills/devspace-compat', 'devspace-compat', 'DevSpace compatibility skill.'],
  ] as const;
  for (const [relativePath, name, description] of fixtures) {
    const skillDirectory = join(home, ...relativePath.split('/'));
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      join(skillDirectory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
    );
  }

  try {
    const workspace = await workspaceRecord(project);
    const service = new InstructionsService({
      resolveWorkspace: async () => workspace,
      homeDirectory: home,
    });
    const result = await service.listSkills({ workspaceId });
    assert.deepEqual(
      result.skills.map((skill) => ({ skillId: skill.skillId, sourceKind: skill.sourceKind })),
      [
        { skillId: 'benchhand-user:benchhand-default', sourceKind: 'benchhand-user' },
        { skillId: 'agents-user:open-standard', sourceKind: 'agents-user' },
        { skillId: 'codex-user:codex-compat', sourceKind: 'codex-user' },
        { skillId: 'devspace-compat:devspace-compat', sourceKind: 'devspace-compat' },
      ],
    );
    assert.deepEqual(result.shadowed, []);
    assert.deepEqual(result.invalid, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads a selected skill body only on explicit skill_read activation', async () => {
  const dir = tempDir('benchhand-skill-read-');
  const project = join(dir, 'project');
  const skillDirectory = join(project, '.agents', 'skills', 'release-check');
  mkdirSync(skillDirectory, { recursive: true });
  const source = [
    '---',
    'name: release-check',
    'description: Validate a release before publishing.',
    'metadata:',
    '  owner: release-team',
    '---',
    '',
    '# Release Check',
    '',
    'Run the full release verification sequence.',
    '',
  ].join('\n');
  writeFileSync(join(skillDirectory, 'SKILL.md'), source);

  try {
    const workspace = await workspaceRecord(project);
    const service = new InstructionsService({ resolveWorkspace: async () => workspace });
    const readApi = service as InstructionsService & {
      readSkill?: (request: {
        workspaceId: typeof workspaceId;
        skillId: string;
      }) => Promise<unknown>;
    };
    assert.equal(typeof readApi.readSkill, 'function', 'expected readSkill API to exist');
    const result = await readApi.readSkill?.({ workspaceId, skillId: 'project:release-check' });
    assert.deepEqual(result, {
      workspaceId,
      skill: {
        skillId: 'project:release-check',
        name: 'release-check',
        description: 'Validate a release before publishing.',
        sourceId: 'project',
        sourceKind: 'project',
        skillDirectoryPath: '.agents/skills/release-check',
        skillFilePath: '.agents/skills/release-check/SKILL.md',
        metadataSha256: sha256(
          [
            'name: release-check',
            'description: Validate a release before publishing.',
            'metadata:',
            '  owner: release-team',
          ].join('\n'),
        ),
        license: null,
        compatibility: null,
        metadata: { owner: 'release-team' },
        allowedTools: null,
      },
      content: source,
      sha256: sha256(source),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports invalid skills without hiding valid catalog entries', async () => {
  const dir = tempDir('benchhand-skills-invalid-');
  const project = join(dir, 'project');
  const validDirectory = join(project, '.agents', 'skills', 'valid-skill');
  const invalidDirectory = join(project, '.agents', 'skills', 'invalid-skill');
  mkdirSync(validDirectory, { recursive: true });
  mkdirSync(invalidDirectory, { recursive: true });
  writeFileSync(
    join(validDirectory, 'SKILL.md'),
    '---\nname: valid-skill\ndescription: A valid skill.\n---\n\nValid body.\n',
  );
  writeFileSync(
    join(invalidDirectory, 'SKILL.md'),
    '---\nname: wrong-directory-name\ndescription: Invalid because the name does not match.\n---\n',
  );

  try {
    const workspace = await workspaceRecord(project);
    const service = new InstructionsService({ resolveWorkspace: async () => workspace });
    const result = await service.listSkills({ workspaceId });
    assert.deepEqual(
      result.skills.map((skill) => skill.skillId),
      ['project:valid-skill'],
    );
    assert.deepEqual(result.shadowed, []);
    assert.equal(result.invalid.length, 1);
    assert.deepEqual(result.invalid[0], {
      sourceId: 'project',
      sourceKind: 'project',
      skillDirectoryPath: '.agents/skills/invalid-skill',
      skillFilePath: '.agents/skills/invalid-skill/SKILL.md',
      errorCode: 'INVALID_SKILL_NAME',
      message:
        'skill name must use lowercase letters, numbers, single hyphens, and match its parent directory',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports a SKILL.md symlink that escapes its skill root instead of reading outside content', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = tempDir('benchhand-skill-symlink-escape-');
  const project = join(dir, 'project');
  const skillDirectory = join(project, '.agents', 'skills', 'escaped-skill');
  const outside = join(dir, 'outside-skill.md');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    outside,
    '---\nname: escaped-skill\ndescription: Must never be loaded through the project skill root.\n---\n\nOutside body.\n',
  );
  symlinkSync(outside, join(skillDirectory, 'SKILL.md'));

  try {
    const workspace = await workspaceRecord(project);
    const service = new InstructionsService({ resolveWorkspace: async () => workspace });
    const result = await service.listSkills({ workspaceId });
    assert.deepEqual(result.skills, []);
    assert.deepEqual(result.shadowed, []);
    assert.equal(result.invalid.length, 1);
    assert.deepEqual(result.invalid[0], {
      sourceId: 'project',
      sourceKind: 'project',
      skillDirectoryPath: '.agents/skills/escaped-skill',
      skillFilePath: '.agents/skills/escaped-skill/SKILL.md',
      errorCode: 'SKILL_FILE_OUTSIDE_ROOT',
      message: 'SKILL.md resolves outside skill root: .agents/skills/escaped-skill/SKILL.md',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
