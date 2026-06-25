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
    client: z.string().optional().default(''),        // which CLIENT/company this project is for
    client_name: z.string().optional().default(''),   // display name of that client
    client_logo: z.string().optional().default(''),   // client logo / hero image
    title: z.string(),
    tagline: z.string().optional().default(''),
    order: z.number().optional().default(100),
    published: z.boolean().optional().default(true),
  }),
});

const reviewItems = defineCollection({
  type: 'data',
  schema: z.object({
    project_key: z.string(),
    section: z.string().optional().default(''),       // free text — you type it
    section_key: z.string().optional().default(''),   // tolerated for old files
    kind: z.string().optional().default(''),          // optional override; normally auto-detected
    title: z.string().optional().default(''),
    label: z.string().optional().default(''),
    version: z.string().optional().default(''),
    stream_uid: z.string().optional().default(''),
    image: z.string().optional().default(''),
    image_url: z.string().optional().default(''),     // tolerated for old files
    src_url: z.string().optional().default(''),
    download_url: z.string().optional().default(''),
    date: z.string().optional().default(''),          // optional override; normally auto from filename
    archived: z.boolean().optional().default(false),
    order: z.number().optional().default(100),
    published: z.boolean().optional().default(true),
  }),
});

export const collections = { work, reviews, reviewProjects, reviewItems };
