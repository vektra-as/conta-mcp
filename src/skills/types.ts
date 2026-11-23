export interface SkillDefinition {
  id: string;
  title: string;
  description: string;
  /** Norwegian and English phrases that should surface this skill. */
  triggers: string[];
  /** Tool names the workflow depends on. Used for the skill index. */
  requiredTools: string[];
  buildMessages(): Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
}
