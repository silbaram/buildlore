import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { record } from '../../src/knowledge/project-knowledge/guards.js';
const documents = new Map<string, unknown>();
async function schema(file: string): Promise<unknown> {
 if (!documents.has(file)) documents.set(file, JSON.parse(await readFile(join(process.cwd(), 'schemas', file), 'utf8')));
 return documents.get(file);
}
export const matchPublishedShape = async (value: unknown, shapeValue: unknown, file = 'project-knowledge-completeness.schema.json'): Promise<void> => {
      if (shapeValue === true) return;
      if (shapeValue === false) { expect.fail('Value is forbidden by the schema'); }
      const shape = record(shapeValue);
      if (typeof shape.$ref === 'string') {
        const [name, fragment = ''] = shape.$ref.split('#');
        let target: unknown = await schema(name || file);
        for (const key of fragment.split('/').slice(1)) target = record(target)[key];
        await matchPublishedShape(value, target, name || file); return;
      }
      if (Array.isArray(shape.oneOf)) {
        let valid = 0;
        for (const alternative of shape.oneOf as unknown[]) { try { await matchPublishedShape(value, alternative, file); valid++; } catch { /* Next closed branch. */ } }
        expect(valid).toBe(1); return;
      }
      if (Object.hasOwn(shape, 'const')) expect(value).toEqual(shape.const);
      if (Array.isArray(shape.enum)) expect(shape.enum).toContainEqual(value);
      if (typeof shape.type === 'string' && !['object', 'array', 'integer', 'null'].includes(shape.type)) {
        expect(typeof value).toBe(shape.type);
      }
      if (Array.isArray(shape.type)) expect(shape.type).toContain(value === null ? 'null' : typeof value);
      if (typeof value === 'string' && typeof shape.pattern === 'string') expect(value).toMatch(new RegExp(shape.pattern, 'u'));
      if (shape.type === 'null') { expect(value).toBeNull(); return; }
      if (shape.type === 'object') {
        const r = record(value), props = shape.properties === undefined ? {} : record(shape.properties);
        for (const key of (shape.required ?? []) as string[]) expect(Object.hasOwn(r, key)).toBe(true);
        for (const [key, child] of Object.entries(r)) {
          const patterns = Object.entries(shape.patternProperties === undefined ? {} : record(shape.patternProperties))
            .filter(([pattern]) => new RegExp(pattern, 'u').test(key));
          for (const [, patternShape] of patterns) await matchPublishedShape(child, patternShape, file);
          if (Object.hasOwn(props, key)) await matchPublishedShape(child, props[key], file);
          else if (!patterns.length && shape.additionalProperties !== undefined) {
            expect(shape.additionalProperties, `Unexpected property ${key} in ${file}`).not.toBe(false);
            await matchPublishedShape(child, shape.additionalProperties, file);
          }
        }
      }
      if (shape.type === 'array') {
        expect(Array.isArray(value)).toBe(true); const items = value as unknown[];
        if (typeof shape.minItems === 'number') expect(items.length).toBeGreaterThanOrEqual(shape.minItems);
        if (typeof shape.maxItems === 'number') expect(items.length).toBeLessThanOrEqual(shape.maxItems);
        const prefix = Array.isArray(shape.prefixItems) ? shape.prefixItems : [];
        for (const [index, item] of items.entries()) await matchPublishedShape(item, prefix[index] ?? shape.items ?? true, file);
      }
      if (shape.type === 'integer') {
        expect(Number.isSafeInteger(value)).toBe(true);
        if (typeof shape.minimum === 'number') expect(Number(value)).toBeGreaterThanOrEqual(shape.minimum);
        if (typeof shape.maximum === 'number') expect(Number(value)).toBeLessThanOrEqual(shape.maximum);
      }
    };
