import { z } from 'zod';
import { OBJECT_KINDS, SEGMENTS } from '../../shared/types';
import type { ObjectKind, Segment } from '../../shared/types';

const endpointSchema = z.object({
  server: z.string().trim().min(1).max(256),
  database: z.string().trim().min(1).max(128),
  port: z.number().int().min(1).max(65535).optional(),
});

export const authModeSchema = z.enum(['sql', 'entra-cli', 'entra-interactive', 'entra-default']);

export const connectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    target: endpointSchema,
    jobs: endpointSchema.nullable().optional().transform((v) => v ?? null),
    jobsSource: z.enum(['auto', 'agent', 'elastic', 'none']).default('auto'),
    auth: z.object({
      mode: authModeSchema,
      user: z.string().trim().max(256).optional(),
      password: z.string().max(1024).optional(),
      tenantId: z.string().trim().max(128).optional(),
      clientId: z.string().trim().max(128).optional(),
    }),
    options: z
      .object({
        encrypt: z.boolean().default(true),
        trustServerCertificate: z.boolean().default(false),
        readOnlyIntent: z.boolean().default(false),
      })
      .default({ encrypt: true, trustServerCertificate: false, readOnlyIntent: false }),
  })
  .superRefine((v, ctx) => {
    if (v.auth.mode === 'sql' && !v.auth.user) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'user'], message: 'user is required for sql auth' });
    }
  });

export type ConnectionInputParsed = z.infer<typeof connectionInputSchema>;

const objectRefSchema = z.object({
  kind: z.enum(OBJECT_KINDS as [ObjectKind, ...ObjectKind[]]),
  schema: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
});

export const refreshRequestSchema = z.object({
  segments: z.union([z.literal('all'), z.array(z.enum(SEGMENTS as [Segment, ...Segment[]])).min(1)]).default('all'),
  mode: z.enum(['full', 'incremental']).default('incremental'),
  objects: z.array(objectRefSchema).max(500).optional(),
});

export const CONNECTION_ID_RE = /^[a-z0-9]{6,32}$/;
