import { z } from "zod";

export const resourceMetaSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().positive()
});

export const pageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
});

export const listQuerySchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export const expectedRevisionSchema = z.object({
  expectedRevision: z.number().int().positive()
});

export type ListQuery = z.infer<typeof listQuerySchema>;

