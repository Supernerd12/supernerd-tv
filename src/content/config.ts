import { defineCollection, z } from 'astro:content';

const work = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    order: z.number().default(100),
    categories: z.array(z.string()).default([]),
    hero: z.string().optional().default(''),
    clips: z.array(z.object({
      label: z.string(),
      video: z.string().optional().default(''),
      poster: z.string().optional().default(''),
    })).default([]),
    storyboards: z.array(z.string()).default([]),
  }),
});

export const collections = { work };
