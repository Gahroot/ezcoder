import { z } from "zod";

/**
 * Converts a Zod schema to a JSON Schema object suitable for provider tool
 * parameter definitions.
 *
 * One subtle quirk we have to handle: `z.discriminatedUnion` and `z.union`
 * emit `{oneOf|anyOf: [...]}` at the ROOT with no `type` key. Anthropic's
 * `input_schema` validator strictly requires `type: "object"` at the root
 * (returns 400 invalid_request_error otherwise — message reads
 * `tools.N.custom.input_schema.type: Field required`).
 *
 * Adding `type: "object"` to the outer envelope is safe — every union
 * member is itself an object schema, so the outer `type: "object"` doesn't
 * change the validated shape; it just satisfies Anthropic's gate.
 *
 * OpenAI accepts both forms; this normalisation is harmless there too.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);
  // Remove $schema and other meta keys providers don't want
  const { $schema: _schema, ...rest } = jsonSchema as Record<string, unknown>;

  // Normalise root unions: if the schema has oneOf/anyOf at the root with no
  // `type`, force `type: "object"`. All discriminated-union tool params
  // (e.g. fusion_comp's action enum) hit this path.
  if (rest.type === undefined && (rest.oneOf || rest.anyOf)) {
    return { type: "object", ...rest };
  }
  return rest;
}
