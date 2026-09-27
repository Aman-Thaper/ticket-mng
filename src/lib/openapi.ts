import { jsonSchemaTransformObject } from 'fastify-type-provider-zod';

type TransformObject = typeof jsonSchemaTransformObject;

/**
 * The type provider emits two components for every schema named with .meta({ id }): an input
 * variant ("EventInput") and an output variant ("Event"). Our named schemas are all responses,
 * so the Input copies are unused noise in the docs. This keeps only components reachable from
 * a route, following $refs recursively.
 */
export const transformObject: TransformObject = (doc) => {
  const spec = jsonSchemaTransformObject(doc);
  const { paths, components } = spec as {
    paths?: unknown;
    components?: { schemas?: Record<string, unknown> };
  };
  const schemas = components?.schemas;
  if (!schemas) return spec;

  const used = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.slice(value.lastIndexOf('/') + 1);
        if (!used.has(name)) {
          used.add(name);
          visit(schemas[name]);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(paths);

  return {
    ...spec,
    components: {
      ...components,
      schemas: Object.fromEntries(Object.entries(schemas).filter(([name]) => used.has(name))),
    },
  } as typeof spec;
};
