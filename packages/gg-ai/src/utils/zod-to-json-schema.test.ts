import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "./zod-to-json-schema.js";

describe("zodToJsonSchema", () => {
  it("converts a simple string schema", () => {
    const result = zodToJsonSchema(z.string());
    expect(result).toHaveProperty("type", "string");
  });

  it("converts an object schema with multiple fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");
    expect(result).toHaveProperty("properties");
    const props = result.properties as Record<string, unknown>;
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("age");
    expect(props).toHaveProperty("active");
  });

  it("includes description from .describe()", () => {
    const schema = z.string().describe("A user's full name");
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "string");
    expect(result).toHaveProperty("description", "A user's full name");
  });

  it("handles optional fields correctly", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");
    const required = result.required as string[];
    expect(required).toContain("required");
    expect(required).not.toContain("optional");
  });

  it("strips the $schema key from output", () => {
    const schema = z.string();
    const result = zodToJsonSchema(schema);
    expect(result).not.toHaveProperty("$schema");
  });

  it("handles nested object and array schemas", () => {
    const schema = z.object({
      tags: z.array(z.string()),
      address: z.object({
        street: z.string(),
        city: z.string(),
      }),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");

    const props = result.properties as Record<string, Record<string, unknown>>;

    // Array field
    expect(props.tags).toHaveProperty("type", "array");
    expect(props.tags).toHaveProperty("items");

    // Nested object field
    expect(props.address).toHaveProperty("type", "object");
    const addressProps = props.address.properties as Record<string, unknown>;
    expect(addressProps).toHaveProperty("street");
    expect(addressProps).toHaveProperty("city");
  });

  it("includes min/max constraints on number schemas", () => {
    const schema = z.number().min(1).max(100);
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "number");
    expect(result).toHaveProperty("minimum", 1);
    expect(result).toHaveProperty("maximum", 100);
  });

  it("forces type:'object' on root discriminated unions (Anthropic compatibility)", () => {
    const schema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("create"), name: z.string() }),
      z.object({ action: z.literal("delete"), id: z.string() }),
    ]);
    const result = zodToJsonSchema(schema);
    // Anthropic's tool input_schema validator REQUIRES root type === 'object'.
    // Without this we get: tools.N.custom.input_schema.type: Field required
    expect(result).toHaveProperty("type", "object");
    // Zod 4 emits oneOf for discriminated unions, anyOf for plain unions.
    const variants = (result.oneOf ?? result.anyOf) as unknown[] | undefined;
    expect(variants).toBeTruthy();
    expect(variants!.length).toBe(2);
  });

  it("forces type:'object' on root z.union too", () => {
    const schema = z.union([
      z.object({ kind: z.literal("a"), value: z.string() }),
      z.object({ kind: z.literal("b"), value: z.number() }),
    ]);
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");
    expect(result.anyOf ?? result.oneOf).toBeTruthy();
  });

  it("does not override an explicit root type", () => {
    const schema = z.object({ name: z.string() });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result).not.toHaveProperty("oneOf");
    expect(result).not.toHaveProperty("anyOf");
  });
});
