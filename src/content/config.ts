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

// ---- Client review portal ----
const reviews = defineCollection({
  type: 'data',
  schema: z.object({
    key: z.string(),
    name: z.string(),
    logo: z.string().optional().default(''),
    url_slug: z.string(),
    published: z.boolean().optional().default(true),
  }),
});

const reviewProjects = defineCollection({
  type: 'data',
  schema: z.object({
    key: z.string(),
    company_key: z.string(),
    title: z.string(),
    tagline: z.string().optional().default(''),
    order: z.number().optional().default(100),
    published: z.boolean().optional().default(true),
  }),
});

const reviewSections = defineCollection({
  type: 'data',
  schema: z.object({
    key: z.string(),                 // unique per section (e.g. "apsa-videos")
    project_key: z.string(),         // which project it belongs to
    name: z.string(),                // display name (Style Frames, Audio, Client Files...)
    order: z.number().optional().default(100),
    published: z.boolean().optional().default(true),
  }),
});

const reviewItems = defineCollection({
  type: 'data',
  schema: z.object({
    section_key: z.string().optional().default(''),
    kind: z.enum(['video', 'image', 'audio', 'file']).optional().default('image'),
    title: z.string().optional().default(''),
    label: z.string().optional().default(''),
    version: z.string().optional().default(''),
    stream_uid: z.string().optional().default(''),
    image: z.string().optional().default(''),
    src_url: z.string().optional().default(''),
    download_url: z.string().optional().default(''),
    date: z.string().optional().default(''),
    archived: z.boolean().optional().default(false),
    order: z.number().optional().default(100),
    published: z.boolean().optional().default(true),
  }),
});

export const collections = { work, reviews, reviewProjects, reviewSections, reviewItems };
