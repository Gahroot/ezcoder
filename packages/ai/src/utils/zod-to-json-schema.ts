import { z } from "zod";

/**
 * Converts a Zod schema to a JSON Schema object suitable for
 * provider tool parameter definitions.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);
  // Remove $schema and other meta keys providers don't want
  const { $schema: _schema, ...rest } = jsonSchema as Record<string, unknown>;
  return rest;
}
