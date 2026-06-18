import { defineCollection, z } from 'astro:content';

const work = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    order: z.number().default(100),
    published: z.boolean().optional().default(true),
    categories: z.array(z.string()).default([]),
    hero: z.string().optional().default(''),
    description: z.string().optional().default(''),
    pieces: z.array(z.object({
      title: z.string(),
      published: z.boolean().optional().default(true),
      hero: z.string().optional().default(''),
      video: z.string().optional().default(''),
      description: z.string().optional().default(''),
      gallery: z.array(z.string()).default([]),
      no_video: z.boolean().optional().default(false),
    })).default([]),
  }),
});

export const collections = { work };
