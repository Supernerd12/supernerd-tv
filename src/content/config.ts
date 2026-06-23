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
    key: z.string(),                 // stable id used to group projects + scope comments (e.g. "trrp")
    name: z.string(),                // shown to the client (e.g. "TRRP")
    logo: z.string().optional().default(''),
    url_slug: z.string(),            // the secret URL: /r/<url_slug>/
    published: z.boolean().optional().default(true),
  }),
});

const reviewProjects = defineCollection({
  type: 'data',
  schema: z.object({
    key: z.string(),                 // stable id (e.g. "animated-psa")
    company_key: z.string(),         // which Review this belongs to
    title: z.string(),
    tagline: z.string().optional().default(''),
    order: z.number().optional().default(100),
    show_style_frames: z.boolean().optional().default(false),
    show_assets: z.boolean().optional().default(false),
    show_storyboards: z.boolean().optional().default(false),
    show_videos: z.boolean().optional().default(true),
    published: z.boolean().optional().default(true),
  }),
});

const reviewItems = defineCollection({
  type: 'data',
  schema: z.object({
    project_key: z.string(),
    section: z.enum(['style-frames', 'assets', 'storyboards', 'videos']),
    kind: z.enum(['video', 'image']),
    title: z.string().optional().default(''),
    label: z.string().optional().default(''),
    version: z.string().optional().default(''),
    stream_uid: z.string().optional().default(''),
    image: z.string().optional().default(''),
    image_url: z.string().optional().default(''),
    order: z.number().optional().default(100),
    published: z.boolean().optional().default(true),
  }),
});

export const collections = { work, reviews, reviewProjects, reviewItems };
