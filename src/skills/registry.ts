import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SkillDefinition } from "./types.js";
import { opprettOgSendFakturaSkill } from "./opprett-og-send-faktura.js";
import { registrerBetalingSkill } from "./registrer-betaling.js";
import { kreditnotaSkill } from "./kreditnota.js";
import { maanedsstatusSkill } from "./maanedsstatus.js";

export const ALL_SKILLS: SkillDefinition[] = [
  opprettOgSendFakturaSkill,
  registrerBetalingSkill,
  kreditnotaSkill,
  maanedsstatusSkill,
];

/**
 * Expose each skill as an MCP prompt, plus a plain-text index resource so a
 * client can discover which workflow fits a request without loading them all.
 */
export function registerSkills(server: McpServer): void {
  for (const skill of ALL_SKILLS) {
    server.registerPrompt(
      skill.id,
      { title: skill.title, description: skill.description },
      () => ({ messages: skill.buildMessages() }),
    );
  }

  server.registerResource(
    "skill-index",
    "conta://skills",
    {
      mimeType: "text/plain",
      description:
        "Oversikt over tilgjengelige Conta-arbeidsflyter med utløserord",
    },
    () => ({
      contents: [
        {
          uri: "conta://skills",
          mimeType: "text/plain",
          text: ALL_SKILLS.map(
            (s) => `${s.id}: ${s.description} [triggers: ${s.triggers.join(", ")}]`
          ).join("\n"),
        },
      ],
    })
  );
}
