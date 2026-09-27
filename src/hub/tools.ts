import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam["content"];

export interface ToolContext {
  signal: AbortSignal;
  /** Short status line shown in the dashboard while a slow tool runs. */
  progress(text: string): void;
}

/** A tool Claude can call, whether built in or provided by a connected game adapter. */
export interface HubTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Beta.BetaTool.InputSchema;
  /** Only set for tools whose input we validate ourselves (required by eager input streaming). */
  eager?: boolean;
  run(input: unknown, ctx: ToolContext): Promise<ToolResultContent>;
}

export class ToolInputError extends Error {}

/** Builds a tool from a zod schema, which is both the JSON schema Claude sees and the runtime validator. */
export function defineTool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  input: S;
  run(input: z.output<S>, ctx: ToolContext): Promise<ToolResultContent> | ToolResultContent;
}): HubTool {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(spec.input, { io: "input" }) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: schema as Anthropic.Beta.BetaTool.InputSchema,
    eager: true,
    async run(input, ctx) {
      const parsed = spec.input.safeParse(input);
      if (!parsed.success) {
        throw new ToolInputError(`Invalid input: ${z.prettifyError(parsed.error)}`);
      }
      return spec.run(parsed.data, ctx);
    },
  };
}

export function toApiTools(tools: HubTool[]): Anthropic.Beta.BetaTool[] {
  // Sorted so the tool list (the start of every request) stays byte-identical and cacheable.
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      ...(t.eager ? { eager_input_streaming: true } : {}),
    }));
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 1);
}
