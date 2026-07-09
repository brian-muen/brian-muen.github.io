import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const writing = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/writing' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string().optional(),
  }),
});

/** Site-relative cover under /covers/bookshelf/, optional ?v= cache-bust. */
const coverPath = z
  .string()
  .regex(/^\/covers\/bookshelf\/[a-z0-9._-]+\.(jpe?g|png|webp|gif)(\?v=\d+)?$/i)
  .optional();

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).optional();

const reading = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/reading' }),
  schema: z.object({
    title: z.string(),
    author: z.string(),
    cover: coverPath,
    dateRead: z.coerce.date().optional(),
  }),
});

const bookshelf = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/bookshelf' }),
  schema: z.object({
    title: z.string(),
    author: z.string(),
    dateRead: z.coerce.date(),
    rating: z.number().min(0).max(5).optional(),
    pages: z.number().optional(),
    pubYear: z.number().optional(),
    dateAdded: z.coerce.date().optional(),
    readCount: z.number().optional(),
    cover: coverPath,
    isbn: z.string().optional(),
    approx: z.boolean().optional(),
    moods: z.array(z.string()).optional(),
    genres: z.array(z.string()).optional(),
    subjects: z.array(z.string()).optional(),
    places: z.array(z.string()).optional(),
    language: z.string().optional(),
    coverColor: hexColor,
    fiction: z.boolean().optional(),
    pace: z.string().optional(),
  }),
});

export const collections = { writing, reading, bookshelf };
