import { z } from "zod";

export const eventIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const eventStatusSchema = z.enum([
  "draft",
  "upcoming",
  "live",
  "ended",
  "archived",
]);

export const eventInputSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(8000).default(""),
    bannerUrl: z.string().url().max(2048).nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    status: eventStatusSchema.default("draft"),
    isVisible: z.boolean().default(false),
  })
  .refine((event) => Date.parse(event.startsAt) < Date.parse(event.endsAt), {
    path: ["endsAt"],
    message: "End date must be after start date",
  });

export const modInputSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(""),
  artworkUrl: z.string().url().max(2048).nullable().optional(),
  externalUrl: z.string().url().max(2048).nullable().optional(),
  position: z.number().int().min(0).max(10000).optional(),
});

export const adminGrantSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase()),
    displayName: z.string().trim().min(1).max(120),
    eventIds: z.array(eventIdSchema).default([]),
  })
  .strict();

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).default(""),
});

const updateBase = z.object({
  eventId: eventIdSchema,
  version: z.number().int().positive(),
});

export const publicEventUpdateSchema = z.discriminatedUnion("type", [
  updateBase.extend({ type: z.literal("mod_revealed"), modId: eventIdSchema }),
  updateBase.extend({ type: z.literal("event_started") }),
  updateBase.extend({ type: z.literal("event_ended") }),
  updateBase.extend({ type: z.literal("event_sync") }),
]);

export type EventStatus = z.infer<typeof eventStatusSchema>;
export type EventInput = z.infer<typeof eventInputSchema>;
export type ModInput = z.infer<typeof modInputSchema>;
export type PublicEventUpdate = z.infer<typeof publicEventUpdateSchema>;
export type PublicEventUpdateInput = PublicEventUpdate extends infer Update
  ? Update extends PublicEventUpdate
    ? Omit<Update, "eventId" | "version">
    : never
  : never;
