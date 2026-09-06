import type { z } from "zod";

/**
 * A tool exactly as the model sees it: its name, its description, and the
 * shape of its parameters.
 *
 * All three are PROMPT SURFACE. A reworded description or a parameter that
 * quietly became optional changes how the model behaves, and no functional test
 * anywhere would notice — which is why the golden fixture this serializes into
 * was captured from the pre-registry code and is compared byte for byte.
 */
export interface ToolSurface {
  name: string;
  description: string;
  /** Parameter name → its serialized zod shape, in declaration order. */
  params: Record<string, ParamSurface>;
}

export interface ParamSurface {
  /** The zod type after every wrapper is unwrapped, e.g. "ZodString". */
  type: string;
  /** True when the model may omit it. An accidental flip changes what it must supply. */
  optional: boolean;
  /** Every `.describe()` on the chain, outermost first: all of it reaches the model. */
  descriptions: string[];
  /** Enum members, in order — the legal values the model is told about. */
  values?: string[];
  /** An array's element type, serialized the same way. */
  element?: ParamSurface;
  /** Number constraints (int, min, max), in zod's own order. */
  checks?: string[];
}

/** The zod v3 internals this reads. Narrow on purpose: anything else is a change worth failing on. */
interface ZodDef {
  typeName?: string;
  description?: string;
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: unknown;
  checks?: { kind: string; value?: unknown }[];
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function serializeParam(schema: z.ZodTypeAny): ParamSurface {
  const descriptions: string[] = [];
  let current = schema;
  let optional = false;

  // Unwrap optional/nullable/default, collecting the descriptions on the way
  // down: `.optional().describe(...)` and `.describe(...).optional()` put the
  // text on different levels and both of them reach the model.
  for (;;) {
    const def = defOf(current);
    if (typeof def.description === "string") descriptions.push(def.description);
    if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault" || def.typeName === "ZodNullable") {
      if (def.typeName !== "ZodNullable") optional = true;
      current = def.innerType as z.ZodTypeAny;
      continue;
    }
    break;
  }

  const def = defOf(current);
  const surface: ParamSurface = {
    type: def.typeName ?? "unknown",
    optional,
    descriptions,
  };
  if (Array.isArray(def.values)) surface.values = def.values.map(String);
  if (def.typeName === "ZodArray" && def.type) surface.element = serializeParam(def.type);
  if (Array.isArray(def.checks) && def.checks.length > 0) {
    surface.checks = def.checks.map((c) => (c.value === undefined ? c.kind : `${c.kind}=${String(c.value)}`));
  }
  return surface;
}

/** Serialize one SDK tool definition. Shape-typed rather than imported: the SDK's own type is generic over the raw shape. */
export function serializeTool(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}): ToolSurface {
  const params: Record<string, ParamSurface> = {};
  for (const [key, schema] of Object.entries(tool.inputSchema)) {
    params[key] = serializeParam(schema);
  }
  return { name: tool.name, description: tool.description, params };
}
