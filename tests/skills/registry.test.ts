import { describe, it, expect } from 'vitest';
import { buildHarness, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../helpers/tool-harness.js';
import { ALL_SKILLS } from '../../src/skills/registry.js';

/**
 * The skills are prose, so there is little logic to test — but two things can
 * silently rot: a skill can reference a tool that does not exist (or that was
 * renamed), and the registry can drift from the skill files. Both are caught
 * here.
 */

const ALL_TOOL_NAMES = new Set<string>([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);

describe('skill registry', () => {
  it('registers the four V1 skills as MCP prompts', () => {
    const harness = buildHarness({ orgId: 1 });

    expect([...harness.prompts.keys()].sort()).toEqual([
      'kreditnota',
      'maanedsstatus',
      'opprett-og-send-faktura',
      'registrer-betaling',
    ]);
  });

  it('exposes a skill index resource', () => {
    const harness = buildHarness({ orgId: 1 });
    const index = harness.resources.get('skill-index');

    expect(index?.uri).toBe('conta://skills');
    const text = index!.handler().contents[0].text;
    for (const skill of ALL_SKILLS) {
      expect(text).toContain(skill.id);
    }
  });
});

describe('skill definitions', () => {
  it.each(ALL_SKILLS.map((s) => [s.id, s] as const))(
    '%s only references tools that actually exist',
    (_id, skill) => {
      // Guards against a skill telling the model to call a renamed or
      // never-implemented tool.
      for (const tool of skill.requiredTools) {
        expect(ALL_TOOL_NAMES, `${skill.id} references unknown tool "${tool}"`).toContain(
          tool,
        );
      }
    },
  );

  it.each(ALL_SKILLS.map((s) => [s.id, s] as const))(
    '%s has triggers, a description and a non-trivial body',
    (_id, skill) => {
      expect(skill.triggers.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.title.length).toBeGreaterThan(0);

      const messages = skill.buildMessages();
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].content.text.length).toBeGreaterThan(200);
    },
  );

  it('has unique skill ids', () => {
    const ids = ALL_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mentions dryRun in every skill that performs a write', () => {
    const writing = ALL_SKILLS.filter((s) =>
      s.requiredTools.some((t) => (WRITE_TOOL_NAMES as readonly string[]).includes(t)),
    );

    expect(writing.length).toBeGreaterThan(0);
    for (const skill of writing) {
      expect(
        skill.buildMessages()[0].content.text,
        `${skill.id} writes data and must mention dryRun`,
      ).toMatch(/dryRun/);
    }
  });

  it('tells the credit-note skill to use the native endpoint, not negative lines', () => {
    // Conta has a real credit-note endpoint; the Tripletex-style negative-line
    // workaround would produce a wrong document here.
    const text = ALL_SKILLS.find((s) => s.id === 'kreditnota')!.buildMessages()[0].content
      .text;

    expect(text).toContain('create_credit_note');
    expect(text).toMatch(/IKKE/);
  });
});
