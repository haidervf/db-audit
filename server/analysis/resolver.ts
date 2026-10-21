import type { ObjectKind, ObjectRef, ResolvedRef } from '../../shared/types';
import { DATABASE_SCOPE_SCHEMA } from '../../shared/types';
import type { AnalysisRefs } from './refs';

/** A cached local object, as far as the resolver cares. */
export interface IndexedObject {
  kind: ObjectKind;
  schema: string;
  name: string;
}

/** A row of sys.synonyms (stored in the cache meta table under 'synonyms'). */
export interface SynonymInfo {
  schema: string;
  name: string;
  /** sys.synonyms.base_object_name, e.g. `[dbo].[OrderLog]` or `[OtherDb].[dbo].[X]` */
  baseObjectName: string;
}

/**
 * Where the analysed text runs, which decides what an unqualified / same-database name means.
 *  - local:          a module of the target database, or a job step that runs in it
 *  - other-database: an Agent job step whose database_name is another database (refs are external to it)
 *  - not-this-db:    an Elastic Jobs step that does not target this database (its databases are not known
 *                    as a single name, so refs are external without a graph node)
 */
export type ResolveScope =
  | { type: 'local'; moduleSchema: string }
  | { type: 'other-database'; database: string }
  | { type: 'not-this-db' };

/** Graph node id of an external object; same shape as the server-dependency external nodes in graph.ts. */
export function externalNodeId(server: string | null, database: string | null, schema: string | null, name: string): string {
  return `external:${[server, database, schema ?? '', name].filter((x) => x !== null).join('.')}`;
}

function objectNodeId(kind: string, schema: string, name: string): string {
  return `${kind}:${schema}.${name}`;
}

/** Splits a (possibly bracketed / quoted) multi-part name: `[a].[b c].d` -> ['a', 'b c', 'd']. Empty parts stay ''. */
export function splitMultipartName(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '[') {
      // bracketed part; `]]` is an escaped `]`
      let j = i + 1;
      for (;;) {
        const k = s.indexOf(']', j);
        if (k < 0) {
          cur += s.slice(j);
          j = s.length;
          break;
        }
        if (s[k + 1] === ']') {
          cur += s.slice(j, k + 1);
          j = k + 2;
          continue;
        }
        cur += s.slice(j, k);
        j = k + 1;
        break;
      }
      i = j;
    } else if (ch === '"') {
      const k = s.indexOf('"', i + 1);
      cur += k < 0 ? s.slice(i + 1) : s.slice(i + 1, k);
      i = k < 0 ? s.length : k + 1;
    } else if (ch === '.') {
      parts.push(cur.trim());
      cur = '';
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * Maps analyzer ObjectRefs to ResolvedRefs against one connection's cache:
 *  - server (4-part) or a database other than the target -> external (`external:<db>.<schema>.<name>`)
 *  - no database, or the target database itself (case-insensitive) -> local; looked up by schema.name
 *    (case-insensitive) across tables / views / procedures / functions / triggers. Unqualified names are
 *    tried in the module's schema first, then dbo (SQL Server's resolution order inside a module).
 *  - a local miss is looked up in sys.synonyms (when the cache has them) and resolved through the base object
 *  - anything else -> unknown (exists: false). Sequences are not cached, so they are always unknown.
 */
export class Resolver {
  private readonly byName = new Map<string, IndexedObject>();
  private readonly synonyms = new Map<string, SynonymInfo>();

  constructor(
    objects: Iterable<IndexedObject>,
    synonyms: Iterable<SynonymInfo>,
    readonly targetDatabase: string,
  ) {
    for (const o of objects) {
      if (o.schema === DATABASE_SCOPE_SCHEMA) continue;
      this.byName.set(`${o.schema}.${o.name}`.toLowerCase(), o);
    }
    for (const s of synonyms) this.synonyms.set(`${s.schema}.${s.name}`.toLowerCase(), s);
  }

  private isTargetDb(db: string | null): boolean {
    return db !== null && db.toLowerCase() === this.targetDatabase.toLowerCase();
  }

  /** Candidate `schema.name` keys for a local lookup. */
  private localKeys(schema: string | null, name: string, moduleSchema: string): string[] {
    if (schema) return [`${schema}.${name}`.toLowerCase()];
    const keys = [`${moduleSchema}.${name}`.toLowerCase()];
    if (moduleSchema.toLowerCase() !== 'dbo') keys.push(`dbo.${name}`.toLowerCase());
    return keys;
  }

  resolve(ref: ObjectRef, scope: ResolveScope): ResolvedRef {
    const base = { key: ref.key, sameDatabaseQualified: false };
    if (ref.server !== null) {
      return { ...base, nodeId: externalNodeId(ref.server, ref.database, ref.schema, ref.name), kind: 'external', exists: false };
    }
    if (ref.database !== null && !this.isTargetDb(ref.database)) {
      return { ...base, nodeId: externalNodeId(null, ref.database, ref.schema, ref.name), kind: 'external', exists: false };
    }
    const sameDb = ref.database !== null;
    if (scope.type === 'other-database') {
      // the text runs in another database: unqualified / same-name refs belong to that database
      return { ...base, nodeId: externalNodeId(null, scope.database, ref.schema, ref.name), kind: 'external', exists: false };
    }
    if (scope.type === 'not-this-db') return { ...base, nodeId: null, kind: 'external', exists: false };
    const local = this.resolveLocal(ref.schema, ref.name, scope.moduleSchema, 0);
    return { ...local, key: ref.key, sameDatabaseQualified: sameDb };
  }

  private resolveLocal(schema: string | null, name: string, moduleSchema: string, depth: number): ResolvedRef {
    const keys = this.localKeys(schema, name, moduleSchema);
    for (const k of keys) {
      const hit = this.byName.get(k);
      if (hit) return { key: k, nodeId: objectNodeId(hit.kind, hit.schema, hit.name), kind: hit.kind, exists: true, sameDatabaseQualified: false };
    }
    if (depth === 0) {
      for (const k of keys) {
        const syn = this.synonyms.get(k);
        if (!syn) continue;
        // base_object_name has 1-4 parts: [[[server.]database.]schema.]name
        const parts = splitMultipartName(syn.baseObjectName).slice(-4);
        while (parts.length < 4) parts.unshift('');
        const [srv, db, sch, objName] = parts as [string, string, string, string];
        const objSchema = sch || null;
        if (srv) return { key: k, nodeId: externalNodeId(srv, db || null, objSchema, objName), kind: 'external', exists: false, sameDatabaseQualified: false };
        if (db && !this.isTargetDb(db)) return { key: k, nodeId: externalNodeId(null, db, objSchema, objName), kind: 'external', exists: false, sameDatabaseQualified: false };
        return this.resolveLocal(objSchema, objName, syn.schema, depth + 1);
      }
    }
    return { key: keys[0]!, nodeId: null, kind: 'unknown', exists: false, sameDatabaseQualified: false };
  }

  /** Resolves every ref of an analysis (tables, procedure / function calls, sequences, cross-database refs). */
  resolveAll(refs: AnalysisRefs, scope: ResolveScope): Record<string, ResolvedRef> {
    const out: Record<string, ResolvedRef> = {};
    const add = (r: ObjectRef) => {
      if (!(r.key in out)) out[r.key] = this.resolve(r, scope);
    };
    for (const t of refs.tables) add(t.ref);
    for (const r of refs.procCalls) add(r);
    for (const f of refs.functionCalls) add(f.ref);
    for (const r of refs.sequences) add(r);
    for (const r of refs.crossDatabaseRefs) add(r);
    return out;
  }
}
